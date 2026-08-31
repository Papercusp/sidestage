---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'/home/marsh-office/.papercusp/hives/sidestage/libs/test-config':24A '1788195081464':42A '261':19A,57A '625ed2bbdaa4':38A 'attach':27A 'attent':48A 'b0d45be802ce':36A 'branch':33A 'commit':60A 'consecut':16A,58A 'detach':28A 'detail':43A 'diverg':31A 'emit':40A 'error':5A,17A,20A 'fail':56A 'failur':12A,51A 'git':3A,45A 'git-sync':44A 'git-sync-error':2A 'har':6A 'head':29A,37A 'kind':1A 'libs/test-config':22A 'local':32A,35A 'main':34A 'messag':23A 'need':47A 'origin':63A 'overs':39A 'publish':14A,53A 'publish-refus':13A,52A 'push':11A,50A,55A 'push-failur':10A,49A 'reach':62A 'reason':9A 'refus':15A,25A,54A 'scope':21A 'sidestag':8A 'slug':7A 'sync':4A,46A 'tick':18A,59A"
escalation: "{\"kind\":\"git-sync-error\",\"harness_slug\":\"sidestage\",\"reasons\":[\"push-failure\",\"publish-refused\"],\"consecutive_error_ticks\":261,\"errors\":[{\"scope\":\"libs/test-config\",\"message\":\"/home/marsh-office/.papercusp/hives/sidestage/libs/test-config: refusing to attach detached HEAD to divergent local branch 'main' (local b0d45be802ce != HEAD 625ed2bbdaa4)\"}],\"oversized\":[],\"emitted_at\":1788195081464,\"detail\":\"git-sync needs attention: push-failure + publish-refused — push failed 261 consecutive ticks (commits NOT reaching origin)\"}"
mtime_ms: 1788195081464
phase: "git-sync"
risk_tier: null
supervisor_notes: null
---


