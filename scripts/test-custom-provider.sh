#!/bin/bash
# Proves the server-side custom-provider path (settings.mutate +
# credentials.set) works over the gateway socket, then cleans up.
# Payloads are built by python3 to avoid shell-escaping corruption.
set -e
SOCK=/vol1/@appcenter/dsh/app.sock
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

call() { # method payload-file -> response json
  local method=$1 payload=$2
  python3 - "$method" "$payload" <<'PY' > "$TMP/body"
import json, sys
method, path = sys.argv[1], sys.argv[2]
with open(path) as fh: payload = json.load(fh)
body = {"type": "client-request", "rpcId": "t", "method": method, "payload": payload}
print(json.dumps(body))
PY
  curl -s --unix-socket "$SOCK" -H "X-Trim-Isadmin: true" -H "Content-Type: application/json" \
    --data "@$TMP/body" "http://nas.local/app/dsh/api/$method"
}

json_out() { python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False)[:$1)"; true; }

echo '{}' > "$TMP/describe"
rev=$(call settings.describe "$TMP/describe" | python3 -c "import json,sys; v=json.load(sys.stdin)['result']['value']; print([n['revision'] for n in v['namespaces'] if n['ns']=='llm-pi-ai'][0])")
echo "current revision: $rev"

echo "=== add provider testgw (expectedRevision=$rev) ==="
python3 - "$rev" > "$TMP/mutate" <<'PY'
import json, sys
rev = int(sys.argv[1])
print(json.dumps({
  "ns": "llm-pi-ai",
  "ops": [{"op": "set", "path": ["providers", "testgw"], "value": {
    "api": "openai-completions",
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "TESTGW_KEY",
    "models": [{"id": "deepseek-chat"}],
  }}],
  "expectedRevision": rev,
}))
PY
call settings.mutate "$TMP/mutate" | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; print('ok:', r.get('ok'), '| revision:', (r.get('value') or {}).get('revision'), '|', (r.get('error') or {}).get('message',''))"

echo "=== store credential TESTGW_KEY ==="
echo '{"ref":"TESTGW_KEY","value":"sk-test-dummy"}' > "$TMP/cred"
call credentials.set "$TMP/cred" | python3 -c "import json,sys; print('ok:', json.load(sys.stdin)['result'].get('ok'))"

echo "=== verify persisted ==="
call settings.describe "$TMP/describe" | python3 -c "import json,sys; v=json.load(sys.stdin)['result']['value']; ns=[n for n in v['namespaces'] if n['ns']=='llm-pi-ai'][0]; print('rev=', ns['revision'], 'providers=', list(ns['value'].get('providers',{}).keys()))"
sudo grep -c TESTGW_KEY /vol1/@appdata/dsh/dsh/.credentials.yaml >/dev/null && echo "credential persisted in .credentials.yaml"

echo "=== cleanup ==="
rev=$(call settings.describe "$TMP/describe" | python3 -c "import json,sys; v=json.load(sys.stdin)['result']['value']; print([n['revision'] for n in v['namespaces'] if n['ns']=='llm-pi-ai'][0])")
python3 - "$rev" > "$TMP/unset" <<'PY'
import json, sys
print(json.dumps({"ns": "llm-pi-ai", "ops": [{"op": "unset", "path": ["providers", "testgw"]}], "expectedRevision": int(sys.argv[1])}))
PY
call settings.mutate "$TMP/unset" | python3 -c "import json,sys; print('unset ok:', json.load(sys.stdin)['result'].get('ok'))"
call credentials.unset "$TMP/cred" | python3 -c "import json,sys; print('cred unset ok:', json.load(sys.stdin)['result'].get('ok'))"
