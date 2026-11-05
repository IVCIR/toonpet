import json

PATH = r"D:/aa3dpet-app/logs/selftest-main.log"

text = None
for enc in ("utf-16", "utf-8-sig", "utf-8"):
    try:
        raw = open(PATH, "rb").read()
        candidate = raw.decode(enc)
        if '{"total":' in candidate:
            text = candidate
            print("decoded with", enc)
            break
    except (UnicodeDecodeError, UnicodeError):
        continue

if text is None:
    text = open(PATH, encoding="utf-8", errors="replace").read()

marker = '{"total":'
i = text.find(marker)
print("marker at", i)
obj, _ = json.JSONDecoder().raw_decode(text[i:])
print("total", obj["total"], "failed", obj["failed"])
keys = ("eyeRawPitch", "bodyYaw", "mouth", "headRawPitch", "maxLeg", "eyeOrientation")
for c in obj["checks"]:
    d = c.get("detail")
    if isinstance(d, dict) and any(k in d for k in keys):
        print(json.dumps({"name": c["name"], "pass": c["pass"], "detail": d}, ensure_ascii=False)[:520])
