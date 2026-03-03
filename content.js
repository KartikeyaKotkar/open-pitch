chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SET_PITCH") {
        const video = document.querySelector("video");

        if (!video) {
            console.log("No video found");
            return;
        }

        // Temporary: using playbackRate to test communication
        const semitones = parseInt(msg.pitch);

        // Convert semitones to playback rate
        const rate = Math.pow(2, semitones / 12);

        video.playbackRate = rate;
    }
});