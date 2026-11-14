// ?debug in the URL: tuning panel, frame counter, act jumps and test handles. Read once,
// imported wherever debug-only code lives.
export const DEBUG = new URLSearchParams(location.search).has('debug');
