---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-4':106A '/papercusp/sidestage.git/'':':39A '/settings/emails.':32A '1786872260924':50A '403':45A '8':121A 'access':36A 'account/credential':84A 'address':27A 'alert':109A 'box':91A 'bridg':4A,15A,54A,115A 'bridge-egress-unreach':14A,114A 'canon':101A 'caus':113A 'confirm':79A 'contact':62A 'could':60A 'destin':86A 'detail':51A 'diverg':5A,55A 'egress':16A,58A,80A,116A 'email':26A 'emit':48A 'error':18A,44A 'exampl':69A 'expect':88A 'fals':47A 'fix':81A 'forc':97A 'force-push':96A 'frozen':75A 'github':3A,53A,57A 'github-bridg':52A 'github-bridge-diverg':2A 'github.com':31A,38A 'github.com/papercusp/sidestage.git/'':':37A 'github.com/settings/emails.':30A 'har':6A 'hive':100A 'kind':1A,13A 'last':78A 'must':23A 'need':9A,107A,111A,118A 'never':95A 'nfatal':33A 'nremot':28A 'off-box':89A 'origin':73A,93A 'owner':10A,108A,112A,119A 'progress':92A 'publish':64A 'push':19A,72A,98A 'ref':102A 'refs/heads/staging':20A 'reject':71A 'remot':21A,67A,83A 'request':41A 'return':43A 'see':29A 'sidestag':8A 'signal':12A 'slug':7A 'sweep':120A 'transient':46A 'transport':59A 'true':11A,110A 'unabl':34A 'unchang':104A 'unreach':17A,117A 'url':42A 'verifi':24A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"sidestage\",\"needs_owner\":true,\"signals\":[{\"kind\":\"bridge-egress-unreachable\",\"errors\":[\"push refs/heads/staging: remote: You must verify your email address.\\nremote: See https://github.com/settings/emails.\\nfatal: unable to access 'https://github.com/Papercusp/sidestage.git/': The requested URL returned error: 403\"],\"transient\":false}],\"emitted_at\":1786872260924,\"detail\":\"github-bridge divergence: the GitHub egress transport could not contact or publish to the remote (for example, a rejected push) — origin is frozen at the last confirmed egress; fix the remote account/credential or destination before expecting off-box progress. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":true,\"needs_owner_cause\":\"bridge-egress-unreachable\",\"needs_owner_sweeps\":8}"
mtime_ms: 1786872260924
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


