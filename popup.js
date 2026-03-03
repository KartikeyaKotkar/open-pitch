const slider = document.getElementById("pitchSlider");
const pitchValue = document.getElementById("pitchValue");

slider.addEventListener("input", async () => {
    const value = slider.value;
    pitchValue.textContent = value + " semitones";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.tabs.sendMessage(tab.id, {
        type: "SET_PITCH",
        pitch: value
    });
});