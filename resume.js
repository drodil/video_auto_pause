if (document.querySelector('video').paused) {
    var evt = new KeyboardEvent('keydown', {'keyCode' : 75, 'which' : 75});
    document.dispatchEvent(evt);
}
