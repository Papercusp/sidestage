---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-1787877869911':45A,80A '-4':46A,81A '0':31A '1':103A '1787880536804':19A '2.8':114A '2c003897c80a':14A '3':10A,58A '4':12A,27A,29A,110A '44m':85A '4h':61A '9912319':33A 'aa4f867':47A,82A 'across':113A 'ago':86A 'break':121A 'candid':13A 'caus':20A,99A 'chang':67A 'checkpoint':4A,53A,59A 'claim':95A 'clear':92A 'confirm':89A 'consecutiv':9A 'cover':41A 'detail':50A 'dispatch':84A 'emit':17A 'fail':73A 'failingtest':15A 'failur':104A 'fals':35A,42A 'fix':124A 'fixer':78A 'flake':123A 'gone':40A,90A 'green':3A,52A,65A 'green-checkpoint':51A 'green-checkpoint-stal':2A 'h':115A 'har':6A 'held':55A 'heldhr':11A 'intermitt':25A 'investig':98A 'kind':1A 'last':64A 'main':56A 'name':107A 'namingtick':28A 'one':119A 'owner':39A 'owner-gon':38A 'ownership':36A 'ownersignatur':48A 'papercusp/test-config':16A,24A,49A,74A,116A 'persist':23A 'reach':70A 'red':94A,111A 'redtick':26A 'releas':72A,77A 'release-fix':76A 'sidestag':8A 'silentredtick':30A 'sinc':62A 'slug':7A 'spanm':32A 'spawnid':43A 'stabil':21A 'stabl':22A,100A 'stage':66A 'stall':5A 'state':37A 'truncatedbylimit':34A 'unfix':120A 'unown':75A 'verdict':112A 'without':91A"
escalation: "{\"kind\":\"green-checkpoint-stall\",\"harness_slug\":\"sidestage\",\"consecutiveReds\":3,\"heldHrs\":4,\"candidate\":\"2c003897c80a\",\"failingTests\":[\"@papercusp/test-config\"],\"emitted_at\":1787880536804,\"cause\":{\"stability\":\"stable\",\"persistent\":[\"@papercusp/test-config\"],\"intermittent\":[],\"redTicks\":4,\"namingTicks\":4,\"silentRedTicks\":0,\"spanMs\":9912319,\"truncatedByLimit\":false},\"ownership\":{\"state\":\"owner-gone\",\"covered\":false,\"spawnId\":\"s-1787877869911-4aa4f867\",\"ownerSignature\":\"@papercusp/test-config\"},\"detail\":\"green-checkpoint has held main for 3 checkpoint(s) (~4h since the last green); staging changes are NOT reaching the release. Failing: @papercusp/test-config. UNOWNED — release-fixer s-1787877869911-4aa4f867 was dispatched 44m ago but is CONFIRMED GONE without clearing this red. Claim it before investigating. CAUSE: STABLE — the same 1 failure(s) were named by ALL 4 red verdicts across 2.8h: @papercusp/test-config. This is one unfixed break, not flake — fix it.\"}"
mtime_ms: 1787880536804
phase: "green-checkpoint-stall"
risk_tier: null
supervisor_notes: null
---


