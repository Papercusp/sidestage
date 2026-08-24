---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-08':15A,23A '-23':24A '-24':16A '..':65A '1':55A '12h':45A '15':18A '1787531569388':33A '2026':14A,22A '32':26A '33.944':19A '36.956':27A 'auto':93A 'auto-recov':92A 'bg':102A 'bg-host':101A 'cannot':76A 'checkpoint':4A,37A 'dbos':104A 'dead':88A 'dead-executor':87A 'detail':34A 'detector':75A 'emit':31A 'engin':105A 'executor':89A 'fail':46A,56A,63A 'failingtest':29A 'fals':10A 'fire':85A 'firestal':9A 'frozen':68A 'green':3A,36A,42A 'green-checkpoint':35A 'green-checkpoint-watchdog':2A 'har':6A 'host':103A 'in-routin':71A 'kind':1A 'last':52A 'lastfiredat':13A 'lastgreenat':21A 'look':108A 'main':66A 'name':54A 'need':106A 'papercusp/sse':30A,50A 'persist':99A 'reaper':90A 'recov':94A 'routin':73A,84A 'run':80A 'see':77A 'sidestag':8A 'silent':38A 'slug':7A 'stall':39A,74A 'suit':64A 't00':17A 't12':25A 'test':48A,57A 'true':12A 'verdict':43A,47A,53A 'verdictstal':11A 'watchdog':5A,40A 'wedg':96A 'z':20A,28A"
escalation: "{\"kind\":\"green-checkpoint-watchdog\",\"harness_slug\":\"sidestage\",\"fireStale\":false,\"verdictStale\":true,\"lastFiredAt\":\"2026-08-24T00:15:33.944Z\",\"lastGreenAt\":\"2026-08-23T12:32:36.956Z\",\"failingTests\":[\"@papercusp/sse\"],\"emitted_at\":1787531569388,\"detail\":\"green-checkpoint silent stall (watchdog): no GREEN verdict in ~12h. Failing verdict test(s): @papercusp/sse — The last verdict named 1 failing test(s), so this IS a failing suite.. `main` is frozen and the in-routine stall detector cannot see this (it runs only when the routine fires). The dead-executor reaper should auto-recover a wedge; if this persists the bg-host / DBOS engine needs a look.\"}"
mtime_ms: 1787531569388
phase: "green-checkpoint-watchdog"
risk_tier: null
supervisor_notes: null
---


