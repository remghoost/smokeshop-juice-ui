// ===== Camera data entry (mobile) =====
// Three flows share one modal:
//   • Add (Input Mode): (1) live barcode scan via ZXing. If the barcode is
//     already a known product, a popup asks how many to add to stock. If it's
//     new, (2) photograph the box front — the box is auto-detected and cropped
//     to a tight bounding box client-side (pure JS, no dependencies), then
//     POSTed to /ocr/extract (which forwards it to the local llama.cpp vision
//     server). The returned fields pre-fill the add form for a quick review.
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
    busy: false, // true while an async op (OCR / sell / stock) is in flight
    torchOn: false,
    stockItem: null, // looked-up product for the stock-add popup

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
        this.torchOn = false;
        this.stockItem = null;
        this._lastCode = null;
        this._consecutive = 0;
        this._clearBoxOverlay();
        // Clear any previous sell / stock results, busy indicators, and torch
        ['cam-sell-result', 'cam-sell-actions', 'cam-sell-busy',
         'cam-stock-result', 'cam-stock-busy'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const torchBtn = document.getElementById('cam-torch-btn');
        if (torchBtn) {
            torchBtn.classList.add('hidden');
            torchBtn.classList.remove('torch-on');
        }
    },

    _show() {
        this.modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
    },

    async close() {
        // Make sure the torch is off before releasing the camera
        await this._setTorch(false);
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
        document.getElementById('cam-step-stock').classList.toggle('hidden', step !== 'stock');
        // Shared viewfinder is visible in the scan + photo + sell + stock
        // steps; the scanline in the scan + sell steps; the shutter only in
        // the photo step.
        document.getElementById('cam-viewfinder').classList.toggle('hidden', step === 'result');
        document.getElementById('cam-scanline').classList.toggle('hidden', step !== 'scan' && step !== 'sell');
        document.getElementById('cam-shutter-row').classList.toggle('hidden', step !== 'photo');
        // The detected-box overlay only makes sense while photographing
        if (step !== 'photo') this._clearBoxOverlay();
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
                    video: {
                        facingMode: 'environment',
                        // Ask for a high-res stream: the decode loop works on a
                        // small canvas so this is free, and the photo capture
                        // gets more pixels on the box = sharper text. 2560-wide
                        // so the OCR capture can keep full detail (see maxDim
                        // below) instead of being downscaled to 1600.
                        width: { ideal: 2560 },
                        height: { ideal: 1920 },
                        // Continuous autofocus keeps the box sharp as the user
                        // moves. Ignored on platforms that don't support it.
                        focusMode: 'continuous'
                    },
                    audio: false
                });
                this.video.srcObject = this.stream;
                await this.video.play();
                this._updateTorchButton();
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

    // ---------- Torch ----------
    _updateTorchButton() {
        const btn = document.getElementById('cam-torch-btn');
        if (!btn || !this.stream) return;
        const track = this.stream.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        btn.classList.toggle('hidden', !caps.torch);
    },

    async _setTorch(on) {
        if (!this.stream) return;
        const track = this.stream.getVideoTracks()[0];
        if (!track) return;
        try {
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (!caps.torch) return;
            await track.applyConstraints({ advanced: [{ torch: !!on }] });
            this.torchOn = !!on;
            const btn = document.getElementById('cam-torch-btn');
            if (btn) btn.classList.toggle('torch-on', this.torchOn);
        } catch (e) {
            console.warn('Torch toggle failed:', e);
        }
    },

    toggleTorch() {
        this._setTorch(!this.torchOn);
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
        // 'add' mode: check whether this barcode is already a known product.
        // Known -> add-to-stock popup. New -> photograph the box.
        this.capturedBarcode = code;
        this.setBusy(true, 'Looking up barcode…');
        fetch('/scan/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        })
            .then(r => r.json().catch(() => ({})))
            .then(data => {
                this.setBusy(false);
                if (data.found) {
                    this.showStockStep(data);
                } else {
                    document.getElementById('cam-barcode-value').textContent = code;
                    this.showStep('photo');
                }
            })
            .catch(() => {
                // Lookup failed — fall back to the photo flow.
                this.setBusy(false);
                document.getElementById('cam-barcode-value').textContent = code;
                this.showStep('photo');
            });
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

    // ---------- Stock-add flow: known barcode -> how many to add ----------
    showStockStep(item) {
        this.stockItem = item;
        document.getElementById('cam-stock-label').textContent = item.label;
        document.getElementById('cam-stock-current').textContent = item.stock;
        document.getElementById('cam-stock-qty').value = 1;
        document.getElementById('cam-stock-result').classList.add('hidden');
        this.showStep('stock');
    },

    stockAdjust(delta) {
        const input = document.getElementById('cam-stock-qty');
        let v = parseInt(input.value, 10);
        if (isNaN(v)) v = 1;
        v = Math.max(1, v + delta);
        input.value = v;
    },

    async confirmStock() {
        if (this.busy || !this.stockItem) return;
        const qty = parseInt(document.getElementById('cam-stock-qty').value, 10);
        if (isNaN(qty) || qty < 1) return;
        this.busy = true;
        const busyEl = document.getElementById('cam-stock-busy');
        const resultEl = document.getElementById('cam-stock-result');
        busyEl.classList.remove('hidden');
        resultEl.classList.add('hidden');
        try {
            const response = await fetch(`/stock/${this.stockItem.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delta: qty })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Failed to update stock');
            }
            // Keep the table row in sync
            const input = document.querySelector(`input.stock-input[data-id="${this.stockItem.id}"]`);
            if (input) input.value = data.stock;
            if (data.reactivated && typeof updateRowActiveState === 'function') {
                updateRowActiveState(this.stockItem.id, true);
            }
            resultEl.textContent = `Added ${qty} — now ${data.stock} in stock`;
            resultEl.className = 'cam-ocr-result ok';
            this.stockItem.stock = data.stock;
            document.getElementById('cam-stock-current').textContent = data.stock;
            if (showScanStatus) {
                showScanStatus(`Added ${qty} to ${this.stockItem.label}`, 'success');
            }
        } catch (err) {
            resultEl.textContent = err.message || 'Failed to update stock';
            resultEl.className = 'cam-ocr-result fail';
        }
        busyEl.classList.add('hidden');
        this.busy = false;
    },

    scanNext() {
        document.getElementById('cam-sell-result').classList.add('hidden');
        document.getElementById('cam-sell-actions').classList.add('hidden');
        document.getElementById('cam-stock-result').classList.add('hidden');
        this._clearBoxOverlay();
        this.showStep(this.mode === 'sell' ? 'sell' : 'scan');
        this.startBarcodeScan();
    },

    // ---------- Step 2: snap the box photo ----------
    // Capture the visible region, detect the box, crop + flatten it, and send
    // the result to OCR. Falls back to the full visible region if no box is
    // found (or OpenCV isn't available).
    async snapPhoto() {
        if (!this.video || this.video.videoWidth === 0) return;
        this.setBusy(true, 'Detecting the box…');
        let photo = null;
        try {
            const box = this._detectBoxBBox(this.video);
            if (box) {
                this._drawBoxOverlay(box);
                // Only crop if the detected box is a reasonable size
                const vis = this._visibleRegion();
                if (box.w > vis.sw * 0.15 && box.h > vis.sh * 0.15) {
                    photo = this._cropToBox(this.video, box);
                }
            }
        } catch (e) {
            console.warn('Box detection failed, using full frame:', e);
        }
        if (!photo) {
            photo = this._captureVisible();
        }
        this.capturedPhoto = photo;
        document.getElementById('cam-photo-preview').src = photo;
        this.showStep('result');
        // Always save the capture — it's exactly what the OCR model saw
        // (cropped when detection succeeded, full-frame fallback otherwise),
        // so we can inspect it to diagnose both OCR and box-detection issues.
        this._saveCapture(photo);
        // runOcr() has a `if (this.busy) return` guard, so clear the flag
        // (set during detection) before handing off to it.
        this.busy = false;
        this.runOcr();
    },

    retakePhoto() {
        this.capturedPhoto = null;
        document.getElementById('cam-photo-preview').removeAttribute('src');
        this._clearBoxOverlay();
        this.showStep('photo');
    },

    // Capture exactly the region the viewfinder shows (4:3, object-fit: cover)
    _captureVisible() {
        const vis = this._visibleRegion();
        // Cap the long edge at 2560px: more pixels on the box = sharper text
        // for the vision model. Kept well under the 10mb JSON body limit.
        const maxDim = 2560;
        const scale = Math.min(1, maxDim / Math.max(vis.sw, vis.sh));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vis.sw * scale));
        canvas.height = Math.max(1, Math.round(vis.sh * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.video, vis.sx, vis.sy, vis.sw, vis.sh, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.92);
    },

    // ---------- Box detection (pure JS, no dependencies) ----------
    // Find the axis-aligned bounding box of the product in the current frame.
    // We downscale the visible region, compute a Sobel edge map, and take the
    // bounding box of the strong edges. The box is the dominant edge source in
    // the frame, so this gives a tight crop around it. Returns {x, y, w, h} in
    // *video* coordinates, or null if no box-like region is found.
    _detectBoxBBox(video) {
        const vis = this._visibleRegion();
        // Downscale for speed
        const maxDim = 320;
        const scale = Math.min(1, maxDim / Math.max(vis.sw, vis.sh));
        const w = Math.max(1, Math.round(vis.sw * scale));
        const h = Math.max(1, Math.round(vis.sh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, vis.sx, vis.sy, vis.sw, vis.sh, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        // Grayscale
        const gray = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        }

        // Sobel gradient magnitude
        const mag = new Float32Array(w * h);
        let maxMag = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
                    + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
                const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
                    + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
                const m = Math.sqrt(gx * gx + gy * gy);
                mag[i] = m;
                if (m > maxMag) maxMag = m;
            }
        }

        // Bounding box of the strong edges (the box outline). A fraction of the
        // max keeps us on the sharpest edges and ignores faint background texture.
        const thresh = maxMag * 0.3;
        let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (mag[y * w + x] > thresh) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    count++;
                }
            }
        }
        // Not enough strong edges -> no box
        if (count < w * h * 0.005) return null;

        // Scale back up to video coordinates
        const invScale = 1 / scale;
        return {
            x: minX * invScale + vis.sx,
            y: minY * invScale + vis.sy,
            w: (maxX - minX) * invScale,
            h: (maxY - minY) * invScale
        };
    },

    // Crop the frame to the detected box (with a small margin) and return it as
    // a JPEG data URL. This removes the background and gives the vision model
    // more pixels on the box text.
    _cropToBox(video, box) {
        const vis = this._visibleRegion();
        const margin = 0.05;
        let x = box.x - box.w * margin;
        let y = box.y - box.h * margin;
        let w = box.w * (1 + 2 * margin);
        let h = box.h * (1 + 2 * margin);
        // Clamp to the visible region
        x = Math.max(vis.sx, x);
        y = Math.max(vis.sy, y);
        if (x + w > vis.sx + vis.sw) w = vis.sx + vis.sw - x;
        if (y + h > vis.sy + vis.sh) h = vis.sy + vis.sh - y;
        w = Math.max(1, w);
        h = Math.max(1, h);

        // Cap the long edge at 2560px so the cropped box keeps full detail for
        // the vision model (matches the full-frame fallback cap above).
        const maxDim = 2560;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.92);
    },

    // Draw the detected box over the live viewfinder so the user can see what
    // will be captured.
    _drawBoxOverlay(box) {
        const overlay = document.getElementById('cam-box-overlay');
        const vf = document.getElementById('cam-viewfinder');
        if (!overlay || !vf) return;
        const rect = vf.getBoundingClientRect();
        overlay.width = Math.max(1, Math.round(rect.width));
        overlay.height = Math.max(1, Math.round(rect.height));
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        const vis = this._visibleRegion();
        const mapX = x => (x - vis.sx) / vis.sw * overlay.width;
        const mapY = y => (y - vis.sy) / vis.sh * overlay.height;
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 3;
        ctx.strokeRect(mapX(box.x), mapY(box.y), box.w / vis.sw * overlay.width, box.h / vis.sh * overlay.height);
        overlay.classList.remove('hidden');
    },

    _clearBoxOverlay() {
        const overlay = document.getElementById('cam-box-overlay');
        if (!overlay) return;
        overlay.classList.add('hidden');
        const ctx = overlay.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
    },

    // Save the capture to the server for diagnosing OCR issues (fire-and-forget)
    _saveCapture(image) {
        const label = this.capturedBarcode ? 'bc_' + this.capturedBarcode : 'capture';
        fetch('/ocr/capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image, label })
        }).catch(e => console.warn('Capture save failed:', e));
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
