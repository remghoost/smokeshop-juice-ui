// ===== Camera data entry (mobile) =====
// Two flows share one modal:
//   • Add (Input Mode): (1) live barcode scan via ZXing, (2) photo of the box
//     front. The photo is downscaled client-side, POSTed to /ocr/extract
//     (which forwards it to the local llama.cpp vision server), and the
//     returned fields pre-fill the add form for a quick human review.
//   • Sell (Sell Mode): (1) live barcode scan, then the code is POSTed to
//     /scan to sell one unit — no USB barcode reader required.
//
// Requires a secure context (HTTPS via `tailscale serve` or localhost) for
// camera access.

const Camera = {
    modal: null,
    video: null,
    stream: null,
    reader: null,
    mode: 'add', // 'add' (two-step data entry) | 'sell' (scan to sell)
    scanning: false,
    capturedBarcode: null,
    capturedPhoto: null, // data URL
    busy: false, // true while an async op (OCR / sell) is in flight

    // Decode-loop state (cropped, throttled, consecutive-read)
    _decodeCanvas: null,
    _decodeCtx: null,
    _lastCode: null,
    _consecutive: 0,
    _decodeTimer: null,

    // Tuning for the live scan. We decode a central ROI of the *visible*
    // region (not the whole frame) on a throttled timer, and require a few
    // identical reads in a row. This is much faster on mobile and avoids the
    // occasional misread you get from decoding partial/edge barcodes.
    ROI_FRACTION: 0.8, // fraction of the visible region to decode
    DECODE_MS: 100, // decode at ~10 fps
    REQUIRED_READS: 2, // consecutive identical reads before accepting

    // ---------- Modal ----------
    open() {
        if (typeof getScanMode === 'function' && getScanMode() !== 'input') {
            toggleScanMode(); // camera entry only makes sense in Input Mode
        }
        this.mode = 'add';
        this._reset();
        this.showStep('scan');
        this._show();
        this.startCamera().then(() => {
            if (this.stream) this.startBarcodeScan();
        });
    },

    openSell() {
        this.mode = 'sell';
        this._reset();
        this.showStep('sell');
        this._show();
        this.startCamera().then(() => {
            if (this.stream) this.startBarcodeScan();
        });
    },

    _reset() {
        this.modal = document.getElementById('camera-modal');
        this.video = document.getElementById('camera-video');
        this.capturedBarcode = null;
        this.capturedPhoto = null;
        this.busy = false;
        this._lastCode = null;
        this._consecutive = 0;
        // Clear any previous sell result / actions / busy indicator
        ['cam-sell-result', 'cam-sell-actions', 'cam-sell-busy'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    },

    _show() {
        this.modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
    },

    close() {
        this.stopCamera();
        this.modal.classList.add('hidden');
        document.body.classList.remove('modal-open');
        this.capturedBarcode = null;
        this.capturedPhoto = null;
    },

    showStep(step) {
        document.getElementById('cam-step-scan').classList.toggle('hidden', step !== 'scan');
        document.getElementById('cam-step-photo').classList.toggle('hidden', step !== 'photo');
        document.getElementById('cam-step-result').classList.toggle('hidden', step !== 'result');
        document.getElementById('cam-step-sell').classList.toggle('hidden', step !== 'sell');
        // Shared viewfinder is visible in the scan + photo + sell steps; the
        // scanline in the scan + sell steps; the shutter only in the photo step.
        document.getElementById('cam-viewfinder').classList.toggle('hidden', step === 'result');
        document.getElementById('cam-scanline').classList.toggle('hidden', step !== 'scan' && step !== 'sell');
        document.getElementById('cam-shutter-row').classList.toggle('hidden', step !== 'photo');
    },

    setBusy(busy, text) {
        this.busy = busy;
        const el = document.getElementById('cam-busy');
        el.classList.toggle('hidden', !busy);
        if (text) el.textContent = text;
    },

    // ---------- Camera ----------
    async startCamera() {
        this.stopCamera();
        // "Starting videoinput failed" (NotReadableError) is usually a
        // transient device lock — the camera is briefly held by the previous
        // stream or another process. Retry a couple of times before giving up.
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; ; attempt++) {
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment' },
                    audio: false
                });
                this.video.srcObject = this.stream;
                await this.video.play();
                return;
            } catch (err) {
                const transient = err && (err.name === 'NotReadableError' || err.name === 'AbortError');
                if (transient && attempt < MAX_ATTEMPTS) {
                    // Back off, fully release the device, then try again.
                    await new Promise(r => setTimeout(r, 400 * attempt));
                    this.stopCamera();
                    continue;
                }
                this.showCameraError(err);
                return;
            }
        }
    },

    stopCamera() {
        this.scanning = false;
        if (this._decodeTimer) {
            clearTimeout(this._decodeTimer);
            this._decodeTimer = null;
        }
        this.reader = null;
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.video) this.video.srcObject = null;
    },

    showCameraError(err) {
        const msg = document.getElementById('cam-error');
        let text = 'Camera unavailable: ' + (err.message || err.name || 'unknown error');
        let retryable = false;
        if (err.name === 'NotAllowedError') {
            text = 'Camera permission denied. Allow camera access in the browser and try again.';
        } else if (err.name === 'NotFoundError') {
            text = 'No camera found on this device.';
        } else if (err.name === 'NotReadableError') {
            // Transient device lock — the camera is briefly held by another
            // process. The auto-retries in startCamera() usually clear it, but
            // if not, let the user tap to retry (the lock releases in a few s).
            text = 'Camera is busy. Tap here to try again.';
            retryable = true;
        } else if (!window.isSecureContext) {
            text = 'Camera requires HTTPS. Serve the app over Tailscale HTTPS (tailscale serve) to use camera entry.';
        }
        msg.textContent = text;
        msg.classList.remove('hidden');
        msg.style.cursor = retryable ? 'pointer' : 'default';
        msg.onclick = retryable ? () => {
            msg.classList.add('hidden');
            this.startCamera().then(() => {
                if (this.stream) this.startBarcodeScan();
            });
        } : null;
    },

    // The region of the raw video frame that the viewfinder actually shows.
    // The viewfinder is a 4:3 box with object-fit: cover, so it crops the
    // center of the frame to 4:3. Both the barcode decoder and the photo
    // capture use this so they operate on exactly what the user sees.
    _visibleRegion() {
        const video = this.video;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const viewAspect = 4 / 3; // matches .cam-viewfinder aspect-ratio
        const videoAspect = vw / vh;
        let visW, visH;
        if (videoAspect > viewAspect) {
            // Video is wider than the viewfinder: the sides are cropped.
            visH = vh;
            visW = vh * viewAspect;
        } else {
            // Video is taller than the viewfinder: top/bottom are cropped.
            visW = vw;
            visH = vw / viewAspect;
        }
        return {
            sx: Math.round((vw - visW) / 2),
            sy: Math.round((vh - visH) / 2),
            sw: Math.round(visW),
            sh: Math.round(visH)
        };
    },

    // ---------- Step 1: live barcode scan ----------
    // We decode a cropped, central region of the frame on a throttled timer
    // (instead of the full frame every animation frame). The crop matches the
    // 4:3 viewfinder so we only decode what the user can actually see, which
    // is far faster on mobile and avoids decoding partial barcodes at the
    // edges. Requiring a couple of identical reads in a row kills the
    // occasional single-frame misread.
    startBarcodeScan() {
        const msg = document.getElementById('cam-error');
        msg.classList.add('hidden');
        if (!window.ZXingBrowser || !window.ZXing) {
            msg.textContent = 'Barcode library failed to load.';
            msg.classList.remove('hidden');
            return;
        }
        // DecodeHintType is an enum object (not a class) in the UMD build, so
        // the hints must be a plain Map keyed by the enum values.
        const hints = new Map();
        hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
            window.ZXing.BarcodeFormat.EAN_13,
            window.ZXing.BarcodeFormat.EAN_8,
            window.ZXing.BarcodeFormat.UPC_A,
            window.ZXing.BarcodeFormat.UPC_E,
            window.ZXing.BarcodeFormat.CODE_128,
            window.ZXing.BarcodeFormat.CODE_39,
            window.ZXing.BarcodeFormat.QR_CODE
        ]);
        this.reader = new window.ZXingBrowser.BrowserMultiFormatReader(hints);
        if (!this._decodeCanvas) {
            this._decodeCanvas = document.createElement('canvas');
            this._decodeCtx = this._decodeCanvas.getContext('2d', { willReadFrequently: true });
        }
        this._lastCode = null;
        this._consecutive = 0;
        this.scanning = true;
        this._decodeLoop();
    },

    _decodeLoop() {
        if (!this.scanning) return;
        const video = this.video;
        if (video && video.videoWidth > 0 && this.reader) {
            // Work out the region the viewfinder actually shows (object-fit:
            // cover on a 4:3 box), then decode a central portion of it.
            const vis = this._visibleRegion();
            const roiW = Math.round(vis.sw * this.ROI_FRACTION);
            const roiH = Math.round(vis.sh * this.ROI_FRACTION);
            const sx = vis.sx + Math.round((vis.sw - roiW) / 2);
            const sy = vis.sy + Math.round((vis.sh - roiH) / 2);

            const canvas = this._decodeCanvas;
            if (canvas.width !== roiW) canvas.width = roiW;
            if (canvas.height !== roiH) canvas.height = roiH;
            this._decodeCtx.drawImage(video, sx, sy, roiW, roiH, 0, 0, roiW, roiH);

            try {
                const result = this.reader.decodeFromCanvas(canvas);
                if (result) {
                    const code = result.getText();
                    if (code === this._lastCode) {
                        this._consecutive++;
                    } else {
                        this._lastCode = code;
                        this._consecutive = 1;
                    }
                    if (this._consecutive >= this.REQUIRED_READS) {
                        this.scanning = false;
                        this.onBarcode(code);
                        return;
                    }
                }
            } catch (e) {
                // No barcode in this frame — keep scanning.
            }
        }
        this._decodeTimer = setTimeout(() => this._decodeLoop(), this.DECODE_MS);
    },

    onBarcode(code) {
        if (this.mode === 'sell') {
            this.sellBarcode(code);
            return;
        }
        this.capturedBarcode = code;
        document.getElementById('cam-barcode-value').textContent = code;
        this.showStep('photo');
        this.setBusy(false);
    },

    // ---------- Sell flow: scan a barcode, sell one unit ----------
    async sellBarcode(code) {
        this.busy = true;
        const resultEl = document.getElementById('cam-sell-result');
        const actionsEl = document.getElementById('cam-sell-actions');
        const busyEl = document.getElementById('cam-sell-busy');
        resultEl.classList.add('hidden');
        actionsEl.classList.add('hidden');
        busyEl.classList.remove('hidden');
        try {
            const response = await fetch('/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Scan failed');
            }
            if (data.sold) {
                // Keep the table + sales panel in sync (they may be hidden in
                // Sell Mode, but the data should still update).
                const input = document.querySelector(`input.stock-input[data-id="${data.id}"]`);
                if (input) input.value = data.stock;
                if (data.deactivated && typeof updateRowActiveState === 'function') {
                    updateRowActiveState(data.id, false);
                }
                if (data.sale && typeof prependSale === 'function') prependSale(data.sale);
                let msg = `${data.label} sold`;
                msg += data.outOfStock ? ' — OUT OF STOCK (disabled)' : ` — ${data.stock} left`;
                this.showSellResult(msg, 'ok');
            } else if (data.unknown) {
                this.showSellResult(`Unknown barcode: ${data.code}`, 'fail');
            } else if (data.inactive) {
                this.showSellResult(`${data.label} is disabled`, 'fail');
            } else {
                this.showSellResult('Scan failed', 'fail');
            }
        } catch (err) {
            this.showSellResult(err.message || 'Scan failed', 'fail');
        }
        busyEl.classList.add('hidden');
        this.busy = false;
        actionsEl.classList.remove('hidden');
    },

    showSellResult(text, type) {
        const el = document.getElementById('cam-sell-result');
        el.textContent = text;
        el.className = 'cam-ocr-result ' + type;
        el.classList.remove('hidden');
    },

    scanNext() {
        document.getElementById('cam-sell-result').classList.add('hidden');
        document.getElementById('cam-sell-actions').classList.add('hidden');
        this.showStep('sell');
        this.startBarcodeScan();
    },

    // ---------- Step 2: snap the box photo ----------
    snapPhoto() {
        if (!this.video || this.video.videoWidth === 0) return;
        // Capture exactly the region the viewfinder shows (4:3, object-fit:
        // cover) so the box fills the frame the way it looks on screen. The
        // old code grabbed the whole (often 16:9) frame, so the box was a
        // small sliver surrounded by background and the vision model lost the
        // fine detail (flavor text, mg) it needs.
        const vis = this._visibleRegion();
        const maxDim = 1600; // higher cap: more pixels on the box = sharper text
        const scale = Math.min(1, maxDim / Math.max(vis.sw, vis.sh));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vis.sw * scale));
        canvas.height = Math.max(1, Math.round(vis.sh * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.video, vis.sx, vis.sy, vis.sw, vis.sh, 0, 0, canvas.width, canvas.height);
        this.capturedPhoto = canvas.toDataURL('image/jpeg', 0.92);
        document.getElementById('cam-photo-preview').src = this.capturedPhoto;
        this.showStep('result');
        this.runOcr();
    },

    retakePhoto() {
        this.capturedPhoto = null;
        document.getElementById('cam-photo-preview').removeAttribute('src');
        this.showStep('photo');
    },

    // ---------- OCR + prefill ----------
    async runOcr() {
        if (this.busy) return;
        this.busy = true;
        this.setBusy(true, 'Reading the box...');
        const resultEl = document.getElementById('cam-ocr-result');
        resultEl.classList.add('hidden');

        try {
            const response = await fetch('/ocr/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: this.capturedPhoto,
                    type: getCurrentFilter()
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'OCR failed');
            }
            this.prefillForm(data);
            this.setBusy(false);
            resultEl.textContent = 'Details filled in — review the form below and press Add.';
            resultEl.className = 'cam-ocr-result ok';
        } catch (err) {
            this.setBusy(false);
            resultEl.textContent = err.message || 'OCR failed. Enter the details manually.';
            resultEl.className = 'cam-ocr-result fail';
        }
        this.busy = false;
    },

    prefillForm(data) {
        const form = document.getElementById('juice-form');
        // Make sure we're in add mode (not editing a row)
        if (document.getElementById('juice-id').value) cancelEdit();

        if (this.capturedBarcode) {
            document.getElementById('barcode').value = this.capturedBarcode;
        }
        if (data.brand_id) {
            document.getElementById('brand').value = data.brand_id;
        }
        if (data.flavor) {
            document.getElementById('flavor').value = data.flavor;
        }
        if (data.mg !== null && data.mg !== undefined) {
            const mgSel = document.getElementById('mg');
            if (mgSel.querySelector(`option[value="${data.mg}"]`)) {
                mgSel.value = data.mg;
            }
        }

        // If the brand didn't match an existing one, surface the raw name so
        // the user can create it (the + button) or type it in.
        if (!data.brand_id && data.brand_raw) {
            const hint = document.getElementById('cam-brand-hint');
            hint.textContent = `Brand "${data.brand_raw}" not found — use + to create it, or pick the closest match.`;
            hint.classList.remove('hidden');
        } else {
            document.getElementById('cam-brand-hint').classList.add('hidden');
        }

        this.close();
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (showScanStatus) {
            showScanStatus('Camera entry complete — review the form and add the product', 'success');
        }
    }
};

// Close on backdrop click or Escape (not while a scan/OCR/sell is in flight)
document.addEventListener('click', (e) => {
    if (e.target.id === 'camera-modal' && !Camera.busy) Camera.close();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && Camera.modal && !Camera.modal.classList.contains('hidden') && !Camera.busy) {
        Camera.close();
    }
});
