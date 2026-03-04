const slider = document.getElementById('pitch');
const display = document.getElementById('display');
const resetBtn = document.getElementById('reset');

// Load saved value
chrome.storage.local.get('pitch', ({ pitch }) => {
    const val = pitch ?? 0;
    slider.value = val;
    display.textContent = formatVal(val);
});

slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    display.textContent = formatVal(val);
    sendPitch(val);
    chrome.storage.local.set({ pitch: val });
});

resetBtn.addEventListener('click', () => {
    slider.value = 0;
    display.textContent = '0';
    sendPitch(0);
    chrome.storage.local.set({ pitch: 0 });
});

function formatVal(v) {
    return v > 0 ? `+${v}` : `${v}`;
}

function sendPitch(semitones) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { type: 'SET_PITCH', semitones });
    });
}