---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-4':87A '0':99A '1788052931040':47A '4096mb':34A '4138mb':32A 'across':72A 'action':67A 'alert':90A 'bridg':4A,15A,51A 'bridge-egress-unreach':14A 'canon':82A 'caus':94A 'could':57A 'detail':48A 'diverg':5A,52A 'egress':16A,54A 'emit':45A 'error':18A 'fals':11A,91A 'forc':78A 'force-push':77A 'git':25A,28A,55A 'github':3A,50A 'github-bridg':49A 'github-bridge-diverg':2A 'har':6A 'hive':81A 'kind':1A,13A 'like':63A 'limit':33A 'local':27A 'ls':20A 'ls-remot':19A 'need':9A,68A,88A,92A,96A 'never':76A 'null':95A 'origin':74A 'owner':10A,66A,89A,93A,97A 'parent':41A 'persist':71A 'pot':24A 'pot-git':23A 'push':79A 'ref':83A 'refs/heads/staging':22A 'refus':26A 'remot':21A 'requir':38A 'rss':31A 'sidecar':36A 'sidestag':8A 'signal':12A 'size':42A 'slug':7A 'spawn':29A,60A 'spawner':35A 'sweep':98A 'tick':62A,73A 'transient':43A,64A 'transport':56A 'true':44A 'unchang':85A 'unless':69A 'unreach':17A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"sidestage\",\"needs_owner\":false,\"signals\":[{\"kind\":\"bridge-egress-unreachable\",\"errors\":[\"ls-remote refs/heads/staging: pot-git: refusing local git spawn at RSS 4138MB (limit 4096MB); spawner sidecar is required at this parent size\"],\"transient\":true}],\"emitted_at\":1788052931040,\"detail\":\"github-bridge divergence: the egress git transport could not be SPAWNED this tick — likely transient; no owner action needed unless it persists across ticks. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":0}"
mtime_ms: 1788052931040
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


