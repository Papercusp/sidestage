---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':14A,20A,24A,34A,39A,46A '1786732532122':27A 'absent':52A 'auto':128A 'auto-resolv':127A 'branch':83A 'build':97A 'cannot':32A 'check':114A 'clean':79A 'clone':80A 'commit':33A,73A 'copi':105A 'count':19A,23A 'deliber':124A,137A 'detach':138A 'detail':28A 'discoveri':65A 'disk':93A 'edit':70A 'emit':25A 'entir':68A 'even':88A 'fetch/merge/push':145A 'file':13A,15A,22A,36A,48A 'fix':99A 'git':3A,30A,59A,101A,122A 'git-sync':29A,121A 'git-sync-strand':2A 'git/config':54A,110A 'gitmodul':107A 'har':6A 'idempot':104A 'init':103A 'kind':1A 'libs/token-kit':11A,45A 'local':96A 'mark':62A 'next':119A 'often':134A 'one':142A 'origin':76A 'package.json':16A 'park':135A 'pass':98A 'path':10A 'pin':116A,139A 'popul':40A 're':113A 're-check':112A 'regist':141A 'resolv':129A 'sidestag':8A 'skip':66A 'slug':7A 'status':61A 'strand':5A,17A,21A 'submodul':9A,18A,43A,56A,60A,102A 'sync':4A,31A,123A 'though':89A 'tick':120A 'track':12A,35A,47A 'unpin':148A 'unregist':42A 'url':57A,108A 'worktre':132A 'would':144A"
escalation: "{\"kind\":\"git-sync-strand\",\"harness_slug\":\"sidestage\",\"submodules\":[{\"path\":\"libs/token-kit\",\"tracked_files\":1,\"files\":[\"package.json\"]}],\"stranded_submodule_count\":1,\"stranded_file_count\":1,\"emitted_at\":1786732532122,\"detail\":\"git-sync CANNOT COMMIT 1 tracked file(s) in 1 POPULATED but UNREGISTERED submodule(s): libs/token-kit (1 tracked file(s)). They are absent from .git/config (no submodule.<name>.url), so 'git submodule status' marks them '-' and discovery skips them entirely — the edits are NOT committed, NOT on origin, and a clean clone of this branch does not have them, even though they are on disk and the local build passes. Fix with: git submodule init <path> (idempotent; copies the .gitmodules URL into .git/config), then re-check the pin before the next tick. git-sync deliberately does NOT auto-resolve this — these worktrees are often parked on deliberate detached pins, and registering one here would fetch/merge/push it and UNPIN it.\"}"
mtime_ms: 1786732532122
phase: "git-sync-strand"
risk_tier: null
supervisor_notes: null
---


