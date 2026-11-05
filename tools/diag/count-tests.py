import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else r"D:/aa3dpet-app/logs/unit-test-run.log"
raw = open(PATH, "rb").read()
for enc in ("utf-16", "utf-8-sig", "utf-8"):
    try:
        text = raw.decode(enc)
        if "pass" in text:
            break
    except (UnicodeDecodeError, UnicodeError):
        continue
else:
    text = raw.decode("utf-8", errors="replace")

passed = [int(x) for x in re.findall(r"(?m)^(?:ℹ|#) pass (\d+)", text)]
failed = [int(x) for x in re.findall(r"(?m)^(?:ℹ|#) fail (\d+)", text)]
print(f"files={len(passed)} pass={sum(passed)} fail={sum(failed)}")
