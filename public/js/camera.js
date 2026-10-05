// ===== Camera data entry (mobile, Input Mode) =====
// Two-step flow: (1) live barcode scan via ZXing, (2) photo of the box front.
// The photo is downscaled client-side, POSTed to /ocr/extract (which forwards
// it to the local llama.cpp vision server), and the returned fields pre-fill
// the add form for a quick human review before submitting.
//
// Requires a secure context (HTTPS via `tailscale serve` or localhost) for
// camera access.

const Camera = {
    modal: null,
    video: null,
    stream: null,
    reader: null,
    scanning: false,
    capturedBarcode: null,
    capturedPhoto: null, // data URL
    ocrBusy: false,

    // ---------- Modal ----------
    open() {
        if (typeof getScanMode === 'function' && getScanMode() !== 'input') {
            toggleScanMode(); // camera entry only makes sense in Input Mode
        }
        this.modal = document.getElementById('camera-modal');
        this.video = document.getElementById('camera-video');
        this.capturedBarcode = null;
        this.capturedPhoto = null;
        this.ocrBusy = false;
        this.showStep('scan');
        this.modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
        this.startCamera().then(() => {
            if (this.stream) this.startBarcodeScan();
        });
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
        // Shared viewfinder is visible in the scan + photo steps; the scanline
        // only in the scan step; the shutter button only in the photo step.
        document.getElementById('cam-viewfinder').classList.toggle('hidden', step === 'result');
        document.getElementById('cam-scanline').classList.toggle('hidden', step !== 'scan');
        document.getElementById('cam-shutter-row').classList.toggle('hidden', step !== 'photo');
    },

    setBusy(busy, text) {
        const el = document.getElementById('cam-busy');
        el.classList.toggle('hidden', !busy);
        if (text) el.textContent = text;
    },

    // ---------- Camera ----------
    async startCamera() {
        this.stopCamera();
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false
            });
            this.video.srcObject = this.stream;
            await this.video.play();
        } catch (err) {
            this.showCameraError(err);
        }
    },

    stopCamera() {
        if (this.reader) {
            this.reader.stop().catch(() => {});
            this.reader = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.video) this.video.srcObject = null;
        this.scanning = false;
    },

    showCameraError(err) {
        const msg = document.getElementById('cam-error');
        let text = 'Camera unavailable: ' + (err.message || err.name || 'unknown error');
        if (err.name === 'NotAllowedError') {
            text = 'Camera permission denied. Allow camera access in the browser and try again.';
        } else if (err.name === 'NotFoundError') {
            text = 'No camera found on this device.';
        } else if (!window.isSecureContext) {
            text = 'Camera requires HTTPS. Serve the app over Tailscale HTTPS (tailscale serve) to use camera entry.';
        }
        msg.textContent = text;
        msg.classList.remove('hidden');
    },

    // ---------- Step 1: live barcode scan ----------
    // decodeFromVideo runs until stopped; its callback fires on each decode.
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
        this.scanning = true;
        this.reader.decodeFromVideo(this.video, (decoded) => {
            if (decoded && this.scanning) {
                this.scanning = false;
                this.onBarcode(decoded.getText());
            }
        }).catch(() => {
            // stream ended (modal closed) — nothing to do
        });
    },

    onBarcode(code) {
        this.capturedBarcode = code;
        document.getElementById('cam-barcode-value').textContent = code;
        this.showStep('photo');
        this.setBusy(false);
    },

    // ---------- Step 2: snap the box photo ----------
    snapPhoto() {
        if (!this.video || this.video.videoWidth === 0) return;
        const maxDim = 1024; // downscale: the vision model doesn't need phone resolution
        const scale = Math.min(1, maxDim / Math.max(this.video.videoWidth, this.video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(this.video.videoWidth * scale);
        canvas.height = Math.round(this.video.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
        this.capturedPhoto = canvas.toDataURL('image/jpeg', 0.8);
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
        if (this.ocrBusy) return;
        this.ocrBusy = true;
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
        this.ocrBusy = false;
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

// Close on backdrop click or Escape (not while OCR is running)
document.addEventListener('click', (e) => {
    if (e.target.id === 'camera-modal' && !Camera.ocrBusy) Camera.close();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && Camera.modal && !Camera.modal.classList.contains('hidden') && !Camera.ocrBusy) {
        Camera.close();
    }
});
