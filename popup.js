const slider = document.getElementById('pitch');
const sliderCents = document.getElementById('pitchCents');
const display = document.getElementById('display');
const resetBtn = document.getElementById('reset');

// Load saved values
chrome.storage.local.get(['pitch', 'pitchCents'], ({ pitch, pitchCents }) => {
    const val = pitch ?? 0;
    const cents = pitchCents ?? 0;
    slider.value = val;
    sliderCents.value = cents;
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

function handleInput() {
    const st = parseFloat(slider.value);
    const cents = parseFloat(sliderCents.value);
    const total = st + (cents / 100);
    
    display.textContent = formatVal(total);
    sendPitch(total);
    chrome.storage.local.set({ pitch: st, pitchCents: cents });
}

resetBtn.addEventListener('click', () => {
    slider.value = 0;
    sliderCents.value = 0;
    display.textContent = '0';
    sendPitch(0);
    chrome.storage.local.set({ pitch: 0, pitchCents: 0 });
});

function formatVal(v) {
    // Round to 2 decimals to avoid floating point noise (e.g. 0.1 + 0.2 = 0.30000000000000004)
    const val = Math.round(v * 100) / 100;
    return val > 0 ? `+${val}` : `${val}`;
}

function sendPitch(semitones) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { type: 'SET_PITCH', semitones });
    });
}