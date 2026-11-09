// Runs the BPM/key analysis off the main thread so the page stays responsive
importScripts('analysis.js');
onmessage = (e) => {
  try { postMessage({ id: e.data.id, result: Analysis.analyzeSamples(e.data.samples) }); }
  catch (err) { postMessage({ id: e.data.id, error: String(err) }); }
};
