const slider = document.getElementById('pitch');
const sliderCents = document.getElementById('pitchCents');
const selectBlockSize = document.getElementById('blockSize');
const smartToggle = document.getElementById('smartProcessing');
const display = document.getElementById('display');
const resetBtn = document.getElementById('reset');

// Load saved values
chrome.storage.local.get(['pitch', 'pitchCents', 'blockSize', 'smartProcessing'], ({ pitch, pitchCents, blockSize, smartProcessing }) => {
    const val = pitch ?? 0;
    const cents = pitchCents ?? 0;
    const bs = blockSize ?? 4096;
    const smart = smartProcessing ?? false;

    slider.value = val;
    sliderCents.value = cents;
    selectBlockSize.value = bs;
    smartToggle.checked = smart;

    selectBlockSize.disabled = smart;
    updateDisplay(val, cents);
});

function updateDisplay(st, cents) {
    const total = parseFloat(st) + (parseFloat(cents) / 100);
    display.textContent = formatVal(total);
}

slider.addEventListener('input', () => {
    handleInput();
});

sliderCents.addEventListener('input', () => {
    handleInput();
});

selectBlockSize.addEventListener('change', () => {
    const bs = parseInt(selectBlockSize.value);
    chrome.storage.local.set({ blockSize: bs });
    sendBlockSize(bs);
});

smartToggle.addEventListener('change', () => {
    const smart = smartToggle.checked;
    chrome.storage.local.set({ smartProcessing: smart });
    selectBlockSize.disabled = smart;

    if (smart) {
        // Compute and send auto block size immediately
        const st = parseFloat(slider.value);
        const cents = parseFloat(sliderCents.value);
        const autoBS = getAutoBlockSize(st + (cents / 100));
        sendBlockSize(autoBS);
    } else {
        // Restore manual block size
        sendBlockSize(parseInt(selectBlockSize.value));
    }
});

function handleInput() {
    const st = parseFloat(slider.value);
    const cents = parseFloat(sliderCents.value);
    const total = st + (cents / 100);

    display.textContent = formatVal(total);
    sendPitch(total);
    chrome.storage.local.set({ pitch: st, pitchCents: cents });

    if (smartToggle.checked) {
        const autoBS = getAutoBlockSize(total);
        sendBlockSize(autoBS);
    }
}

function getAutoBlockSize(totalSemitones) {
    const absST = Math.abs(totalSemitones);
    if (absST <= 3) return 4096;
    if (absST <= 6) return 2048;
    if (absST <= 9) return 1024;
    return 512;
}

resetBtn.addEventListener('click', () => {
    slider.value = 0;
    sliderCents.value = 0;
    display.textContent = '0';
    sendPitch(0);
    chrome.storage.local.set({ pitch: 0, pitchCents: 0 });

    if (smartToggle.checked) {
        sendBlockSize(4096); // Auto size for 0st
    }
});

function formatVal(v) {
    // Round to 2 decimals to avoid floating point noise (e.g. 0.1 + 0.2 = 0.30000000000000004)
    const val = Math.round(v * 100) / 100;
    return val > 0 ? `+${val}` : `${val}`;
}

function sendPitch(semitones) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab || !tab.url || !tab.url.includes('youtube.com')) return;
        try {
            chrome.tabs.sendMessage(tab.id, { type: 'SET_PITCH', semitones });
        } catch (e) {
            // Silently ignore if content script not ready
        }
    });
}

function sendBlockSize(blockSize) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab || !tab.url || !tab.url.includes('youtube.com')) return;
        try {
            chrome.tabs.sendMessage(tab.id, { type: 'SET_BLOCK_SIZE', blockSize });
        } catch (e) {
            // Silently ignore
        }
    });
}

// Keep UI in sync with storage changes (e.g. resets from content.js).
// Fix #5 audit: This listener also fires for changes made by this popup (e.g.
// handleInput → storage.set). This is safe because setting slider.value
// programmatically does NOT fire the 'input' event, so no feedback loop or
// double-send can occur.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.pitch) {
        slider.value = changes.pitch.newValue;
    }
    if (changes.pitchCents) {
        sliderCents.value = changes.pitchCents.newValue;
    }
    if (changes.blockSize) {
        selectBlockSize.value = changes.blockSize.newValue;
    }
    if (changes.smartProcessing) {
        smartToggle.checked = changes.smartProcessing.newValue;
        selectBlockSize.disabled = changes.smartProcessing.newValue;
    }

    // Update the visual display if pitch or cents changed
    if (changes.pitch || changes.pitchCents) {
        const val = slider.value;
        const cents = sliderCents.value;
        updateDisplay(val, cents);
    }
});