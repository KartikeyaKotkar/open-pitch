/**
 * OpenPitch — content.js
 * Real-time pitch shifting for YouTube videos using SoundTouch.
 * The audio is routed through a ScriptProcessorNode that feeds samples
 * into the SoundTouch engine, which shifts pitch without changing speed.
 *
 * Key design:
 *  - source → scriptProcessor → destination   (when pitch ≠ 0)
 *  - source → destination                      (when pitch = 0, bypass)
 *
 * The ScriptProcessorNode reads raw PCM from the source via an
 * AnalyserNode trick (or directly), processes it through SoundTouch,
 * and writes the pitch-shifted samples to the output buffer.
 */

let audioCtx = null;
let sourceNode = null;
let scriptProcessor = null;
let currentVideo = null;
let soundtouch = null;
let currentSemitones = 0;

// We accumulate input samples in a ring-buffer that SoundTouch reads from.
let inputL = null;
let inputR = null;
let inputWritePos = 0;
let inputReadPos = 0;
const RING_SIZE = 16384; // must be power of 2

// ─── Main entry ───────────────────────────────────────────────────────────────

function init(semitones) {
    const video = document.querySelector('video');
    if (!video) { console.warn('[OpenPitch] No video element found.'); return; }

    // New video (SPA navigation) — rebuild from scratch
    if (video !== currentVideo) teardown();

    if (!audioCtx) {
        buildChain(video);
    }

    applyPitch(semitones);
}

// ─── Build audio graph ────────────────────────────────────────────────────────

function buildChain(video) {
    currentVideo = video;

    try {
        audioCtx = new AudioContext();
    } catch (e) {
        console.error('[OpenPitch] Could not create AudioContext:', e);
        return;
    }

    try {
        sourceNode = audioCtx.createMediaElementSource(video);
    } catch (e) {
        // Already captured by a previous call — reuse the existing context
        console.warn('[OpenPitch] createMediaElementSource failed (already captured?):', e);
        audioCtx.close();
        audioCtx = null;
        return;
    }

    // Start with direct connection so audio always plays
    sourceNode.connect(audioCtx.destination);

    // Resume AudioContext — Chrome requires a user gesture
    const resume = () => audioCtx?.resume();
    document.addEventListener('click', resume, { once: true });
    document.addEventListener('keydown', resume, { once: true });
    if (!video.paused) audioCtx.resume();

    console.log('[OpenPitch] Audio chain built. State:', audioCtx.state);
}

// ─── Pitch application ────────────────────────────────────────────────────────

function applyPitch(semitones) {
    if (!audioCtx || !sourceNode) return;

    // Ensure AudioContext is running
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => applyPitch(semitones));
        return;
    }

    currentSemitones = semitones;

    // Disconnect everything cleanly before rewiring
    try { sourceNode.disconnect(); } catch { }
    try { scriptProcessor?.disconnect(); } catch { }

    if (semitones === 0) {
        // Bypass: straight wire, no processing
        cleanupProcessor();
        sourceNode.connect(audioCtx.destination);
        console.log('[OpenPitch] Bypass mode (0 semitones).');
        return;
    }

    // Check if SoundTouch is available
    if (typeof SoundTouch === 'undefined') {
        console.warn('[OpenPitch] SoundTouch not found. Playing audio without pitch shift.');
        sourceNode.connect(audioCtx.destination);
        return;
    }

    try {
        setupSoundTouchProcessor(semitones);
    } catch (e) {
        // Pitch node failed — reconnect directly so audio is never lost
        console.error('[OpenPitch] Pitch processor error, falling back to direct output:', e);
        cleanupProcessor();
        try { sourceNode.connect(audioCtx.destination); } catch { }
    }
}

// ─── SoundTouch ScriptProcessor setup ─────────────────────────────────────────

function setupSoundTouchProcessor(semitones) {
    const BUFFER_SIZE = 4096;

    // Create or reconfigure SoundTouch instance
    soundtouch = new SoundTouch();
    soundtouch.pitchSemitones = semitones;

    // Initialize ring buffer for feeding samples to SoundTouch
    inputL = new Float32Array(RING_SIZE);
    inputR = new Float32Array(RING_SIZE);
    inputWritePos = 0;
    inputReadPos = 0;

    // Create a ScriptProcessorNode to capture audio from the source
    // and output pitch-shifted audio.
    // We use a splitter to get individual channels from the source,
    // feed them into the ring buffer via an intermediate ScriptProcessor,
    // then a second processor reads from SoundTouch output.

    // Simpler approach: use a single ScriptProcessor that sits between
    // source and destination. Input samples go into SoundTouch, output
    // comes from SoundTouch.
    scriptProcessor = audioCtx.createScriptProcessor(BUFFER_SIZE, 2, 2);

    scriptProcessor.onaudioprocess = function (event) {
        const inputBuffer = event.inputBuffer;
        const outputBuffer = event.outputBuffer;

        const inL = inputBuffer.getChannelData(0);
        const inR = inputBuffer.getChannelData(1);
        const outL = outputBuffer.getChannelData(0);
        const outR = outputBuffer.getChannelData(1);

        const numFrames = inL.length;

        // Feed interleaved samples into SoundTouch input buffer
        const interleaved = new Float32Array(numFrames * 2);
        for (let i = 0; i < numFrames; i++) {
            interleaved[i * 2] = inL[i];
            interleaved[i * 2 + 1] = inR[i];
        }

        soundtouch.inputBuffer.putSamples(interleaved, 0, numFrames);

        // Process
        soundtouch.process();

        // Read output from SoundTouch
        const availableFrames = soundtouch.outputBuffer.frameCount;
        if (availableFrames >= numFrames) {
            const output = new Float32Array(numFrames * 2);
            soundtouch.outputBuffer.receiveSamples(output, numFrames);
            for (let i = 0; i < numFrames; i++) {
                outL[i] = output[i * 2];
                outR[i] = output[i * 2 + 1];
            }
        } else if (availableFrames > 0) {
            // Partial output — use what we have, zero-pad the rest
            const output = new Float32Array(availableFrames * 2);
            soundtouch.outputBuffer.receiveSamples(output, availableFrames);
            for (let i = 0; i < availableFrames; i++) {
                outL[i] = output[i * 2];
                outR[i] = output[i * 2 + 1];
            }
            for (let i = availableFrames; i < numFrames; i++) {
                outL[i] = 0;
                outR[i] = 0;
            }
        } else {
            // No output yet — silence (will catch up on next block)
            outL.fill(0);
            outR.fill(0);
        }
    };

    // Wire: source → scriptProcessor → destination
    sourceNode.connect(scriptProcessor);
    scriptProcessor.connect(audioCtx.destination);

    console.log('[OpenPitch] SoundTouch processor connected. Semitones:', semitones,
        'Pitch factor:', Math.pow(2, semitones / 12).toFixed(4));
}

function cleanupProcessor() {
    if (scriptProcessor) {
        scriptProcessor.onaudioprocess = null;
        try { scriptProcessor.disconnect(); } catch { }
        scriptProcessor = null;
    }
    soundtouch = null;
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

function teardown() {
    try { sourceNode?.disconnect(); } catch { }
    cleanupProcessor();
    try { audioCtx?.close(); } catch { }
    audioCtx = sourceNode = currentVideo = null;
    currentSemitones = 0;
    console.log('[OpenPitch] Torn down.');
}

// ─── Message listener (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SET_PITCH') {
        init(msg.semitones);
    }
});

// ─── Restore saved pitch on page load ─────────────────────────────────────────

chrome.storage.local.get('pitch', ({ pitch }) => {
    const val = (typeof pitch === 'number') ? pitch : 0;
    if (val !== 0) {
        const observer = new MutationObserver(() => {
            if (document.querySelector('video')) {
                observer.disconnect();
                init(val);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
});

// ─── YouTube SPA navigation ───────────────────────────────────────────────────

document.addEventListener('yt-navigate-finish', () => {
    teardown();
    chrome.storage.local.get('pitch', ({ pitch }) => {
        const val = (typeof pitch === 'number') ? pitch : 0;
        if (val !== 0) init(val);
    });
});