"""One-time fix: grant `allUsers` the Cloud Run "invoker" role on Tabled's
callable functions, so the browser's CORS preflight can reach them.

Firebase callable functions are DESIGNED to be publicly invocable — "public"
only means a request may reach the function; every function still checks your
Firebase Auth token inside (requireAuth) and enforces permissions in code. Gen-2
deploys here didn't grant this, so every callable 403'd the browser. This sets
it, using your existing Firebase CLI login (no gcloud required).

Run once, from anywhere:  python fix-invoker.py
"""
import json, os, time, urllib.request, urllib.error

PROJECT = "tabled-2ad11"
REGION = "us-central1"

# The browser-invoked callables. Firestore triggers and scheduled functions are
# deliberately NOT here — they aren't called from a browser and must stay private.
CALLABLES = [
    "searchgames", "getgamedetails", "geocodearea", "createrequest", "bookslot",
    "confirmsold", "adminaction", "setuserrole", "bumplistingcounter",
    "releasemeetingaddress", "readmeetingaddress", "confirmpickup", "findsafespots",
]

# firebase-tools' own public OAuth client (used only to refresh YOUR token for
# YOUR project — exactly what the firebase CLI does under the hood).
FB_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
FB_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"

def config_path():
    for p in [os.path.expanduser("~/.config/configstore/firebase-tools.json"),
              os.path.join(os.environ.get("APPDATA", ""), "configstore", "firebase-tools.json")]:
        if os.path.isfile(p):
            return p
    raise SystemExit("Could not find firebase-tools.json — run `firebase login` first.")

def get_token():
    cfg = config_path()
    d = json.load(open(cfg, encoding="utf-8"))
    t = d.get("tokens", {})
    if t.get("access_token") and (t.get("expires_at", 0) / 1000.0) > time.time() + 120:
        return t["access_token"]
    # refresh
    body = urllib.parse.urlencode({
        "client_id": FB_CLIENT_ID, "client_secret": FB_CLIENT_SECRET,
        "refresh_token": t["refresh_token"], "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["access_token"]

import urllib.parse
AT = get_token()
BASE = "https://run.googleapis.com/v2/projects/%s/locations/%s/services/" % (PROJECT, REGION)

def api(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={"Authorization": "Bearer " + AT, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def grant(svc):
    code, pol = api("GET", BASE + svc + ":getIamPolicy")
    if code != 200:
        return "GET failed %d: %s" % (code, pol.get("error", {}).get("message", pol))
    bindings = pol.get("bindings", [])
    inv = next((b for b in bindings if b.get("role") == "roles/run.invoker"), None)
    if inv and "allUsers" in inv.get("members", []):
        return "already public"
    if inv:
        inv.setdefault("members", []).append("allUsers")
    else:
        bindings.append({"role": "roles/run.invoker", "members": ["allUsers"]})
    pol["bindings"] = bindings
    code, res = api("POST", BASE + svc + ":setIamPolicy", {"policy": pol})
    if code != 200:
        return "SET failed %d: %s" % (code, res.get("error", {}).get("message", res))
    return "OK -> public invoker"

print("Granting invoker on %d callable functions in %s...\n" % (len(CALLABLES), PROJECT))
for svc in CALLABLES:
    print("  %-24s %s" % (svc, grant(svc)))
print("\nDone. Reload the app and try search / requesting a game.")
