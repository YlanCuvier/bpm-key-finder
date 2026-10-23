"""BPM & Key Finder: serves the page, searches Apple Music, analyzes 30s previews in memory.

Run:  python3 server.py   then open http://localhost:8765
"""
import json
import os
import subprocess
import urllib.parse
import urllib.request
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

SR = 22050
PORT = int(os.environ.get('PORT', 8765))
HOST = os.environ.get('HOST', '127.0.0.1')
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
# Key profiles (major, minor): Krumhansl-Kessler, Temperley, and Faraldo's EDM profile. Scores are summed.
PROFILES = [
    (np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
     np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])),
    (np.array([5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4]),
     np.array([5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4])),
    (np.array([.1652, .0475, .0829, .0669, .0999, .0927, .0529, .1316, .0522, .0744, .0694, .0643]),
     np.array([.1724, .0400, .0761, .1210, .0534, .0937, .0513, .1347, .0941, .0387, .0765, .0482])),
]
BASS_WEIGHT = 0.6   # extra weight of notes under 250 Hz (bass / 808) in the key profile match
THIRD_WEIGHT = 0.02  # how much the minor-vs-major third evidence nudges near ties
UNSURE_MARGIN = 0.05


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def itunes(endpoint, **params):
    return json.loads(fetch(f'https://itunes.apple.com/{endpoint}?{urllib.parse.urlencode(params)}'))['results']


def artist_songs(artist_id, country):
    """Every song on the artist's albums/EPs/singles plus their top tracks (features), newest first."""
    albums = [r['collectionId'] for r in itunes('lookup', id=artist_id, entity='album', limit=200, country=country)
              if r.get('wrapperType') == 'collection']
    tracks = itunes('lookup', id=artist_id, entity='song', limit=200, country=country)
    for i in range(0, len(albums), 50):
        ids = ','.join(map(str, albums[i:i + 50]))
        tracks += itunes('lookup', id=ids, entity='song', limit=200, country=country)
    songs, seen = [], set()
    for t in sorted((t for t in tracks if t.get('wrapperType') == 'track' and t.get('previewUrl')),
                    key=lambda t: t.get('releaseDate', ''), reverse=True):
        name = t['trackName'].lower().strip()
        if name not in seen:
            seen.add(name)
            songs.append(t)
    return songs


def decode(data):
    """Decode audio bytes to mono float32 at SR using ffmpeg, all in memory."""
    out = subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1'],
        input=data, capture_output=True)
    x = np.frombuffer(out.stdout, dtype=np.float32)
    if len(x) < SR * 3:
        raise ValueError('could not decode preview: ' + out.stderr.decode()[-200:])
    return x


def stft_mag(x, n, hop):
    frames = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(x[idx] * np.hanning(n), axis=1))


def detect_bpm(x):
    n, hop = 1024, 256
    fps = SR / hop
    logmag = np.log1p(100 * stft_mag(x, n, hop))
    flux = np.maximum(0, np.diff(logmag, axis=0)).sum(axis=1)
    # Remove slow trend (local mean over ~0.5 s) and half-wave rectify
    w = int(fps * 0.5) | 1
    env = np.maximum(0, flux - np.convolve(flux, np.ones(w) / w, mode='same'))
    # Autocorrelation of the onset envelope
    max_lag = int(fps * 60 / 40) * 4 + 2
    acf = np.correlate(env, env, mode='full')[len(env) - 1:][:max_lag]
    # Score candidate tempos with a comb over beat multiples, weighted by a tempo prior around 120 BPM
    bpms = np.arange(60, 200.01, 0.1)
    lags = fps * 60 / bpms
    score = sum(np.interp(k * lags, np.arange(len(acf)), acf) for k in range(1, 5))
    score *= np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
    return int(round(bpms[np.argmax(score)]))


def tonal_chroma(x):
    """Pitch-class energy from tonal spectral peaks only (drums/noise mostly ignored), tuning-corrected.
    Returns (full-range chroma, bass chroma), each summing to 1."""
    n, hop = 8192, 2048
    mag = stft_mag(x, n, hop)
    # A peak counts if it is a local maximum well above the local spectral median
    padded = np.pad(mag, ((0, 0), (15, 15)), mode='edge')
    med = np.median(np.lib.stride_tricks.sliding_window_view(padded, 31, axis=1), axis=2)
    peak = np.zeros_like(mag, dtype=bool)
    peak[:, 1:-1] = (mag[:, 1:-1] > mag[:, :-2]) & (mag[:, 1:-1] >= mag[:, 2:])
    freqs = np.arange(mag.shape[1]) * SR / n
    peak &= (mag > 3 * med) & ((freqs >= 50) & (freqs <= 3000))[None, :]
    fi, ki = np.nonzero(peak)
    # Parabolic interpolation for a precise peak frequency
    a, b, c = (np.log(mag[fi, ki + d] + 1e-9) for d in (-1, 0, 1))
    freq = (ki + 0.5 * (a - c) / (a - 2 * b + c)) * SR / n
    midi = 69 + 12 * np.log2(freq / 440)
    weight = np.log1p(mag[fi, ki] / med[fi, ki])
    # Songs are not always tuned to A=440; estimate the offset and compensate
    tuning = np.angle(np.sum(weight * np.exp(2j * np.pi * (midi - np.round(midi))))) / (2 * np.pi)
    pc = np.round(midi - tuning).astype(int) % 12
    full = np.bincount(pc, weights=weight, minlength=12)
    low = freq < 250
    bass = np.bincount(pc[low], weights=weight[low], minlength=12)
    return full / max(full.sum(), 1e-9), bass / max(bass.sum(), 1e-9)


def key_name(tonic, minor):
    if minor:
        return f'{NOTES[tonic]} minor', f'{CAMELOT_MAJOR[(tonic + 3) % 12]}A'
    return f'{NOTES[tonic]} major', f'{CAMELOT_MAJOR[tonic]}B'


def detect_key(x):
    full, bass = tonal_chroma(x)
    chroma, third_src = full + BASS_WEIGHT * bass, full + bass
    scores = np.zeros((12, 2))  # [tonic, 0=major / 1=minor]
    for tonic in range(12):
        rotated = np.roll(chroma, -tonic)
        for major, minor in PROFILES:
            scores[tonic, 0] += np.corrcoef(rotated, major)[0, 1]
            scores[tonic, 1] += np.corrcoef(rotated, minor)[0, 1]
        # Minor third vs major third above the tonic decides close major/minor calls
        m3, M3 = third_src[(tonic + 3) % 12], third_src[(tonic + 4) % 12]
        nudge = THIRD_WEIGHT * (m3 - M3) / max(m3 + M3, 1e-9)
        scores[tonic, 1] += nudge
        scores[tonic, 0] -= nudge
    order = np.argsort(scores.ravel())[::-1]
    best, second = (divmod(int(i), 2) for i in order[:2])
    key, camelot = key_name(*best)
    result = {'key': key, 'camelot': camelot}
    if scores[best] - scores[second] < UNSURE_MARGIN:
        result['alt'] = key_name(*second)[0]
    return result


@lru_cache(maxsize=500)
def analyze(url):
    x = decode(fetch(url))
    return {'bpm': detect_bpm(x), **detect_key(x)}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(Path(__file__).parent), **kw)

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            term, country = q.get('term', [''])[0], q.get('country', ['fr'])[0]
            if u.path == '/api/search':
                songs = itunes('search', term=term, country=country, media='music', entity='song', limit=25)
                return self.send_json(200, [r for r in songs if r.get('previewUrl')])
            if u.path == '/api/artists':
                return self.send_json(200, itunes('search', term=term, country=country, media='music',
                                                  entity='musicArtist', attribute='artistTerm', limit=10))
            if u.path == '/api/artist':
                return self.send_json(200, artist_songs(q.get('id', [''])[0], country))
            if u.path == '/api/analyze':
                url = q.get('url', [''])[0]
                host = urllib.parse.urlparse(url).hostname or ''
                if not host.endswith(('.apple.com', '.mzstatic.com')):
                    return self.send_json(400, {'error': 'not an Apple preview URL'})
                return self.send_json(200, analyze(url))
        except Exception as e:
            return self.send_json(500, {'error': str(e)})
        return super().do_GET()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    print(f'BPM & Key Finder running at http://{HOST}:{PORT}', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
