# Challenge brief (authoritative, current)

> Verbatim from the updated challenge instructions provided by Avi on
> 2026-08-16. This supersedes the earlier instruction set the first PRD/TDD
> drafts were written against. PRD.md, TDD.md, and submission.md are kept in
> sync with THIS text.

The Challenge: SideStage (Live Selling Copilot)
A real-time AI copilot for live-commerce sellers

The Opportunity
Live-commerce sellers juggle chat, product questions, listings, inventory, and conversion in real time. The wedge is a seller copilot that centralizes engagement and operational actions while keeping automated replies grounded and controlled.

Your Build
Build a real-time seller copilot that:

Ingests a live chat stream and grounds suggested or automatic replies in catalog, listing, and policy data.
Enforces price, availability, policy, and tone guardrails before any reply is sent.
Supports listing or inventory actions such as push, swap, markdown, or stock adjustment.
Provides on-demand product research with a sub-2-second reply-latency target.
Depth area: Go deep in at least one area: retrieval and function calling, streaming, agentic-write safety, seller UX, or live-commerce workflows.

How We Evaluate
Working prototype: This is the main event. Source code is required and the implementation must run: include the exact command (or live URL) that runs it end to end, and the exact command that runs your tests — we execute both before scheduling a panel.
Build quality: Rough is fine, and you may use any tools or AI assistants. A polished prompt, generated document, or thin LLM wrapper is not enough.
Review order: Reviewers start with the PRD and TDD, then verify the implementation through the prototype and source code.
PRD
Define the first seller workflow, the copilot-to-automation ladder, a pilot with 3-5 sellers, and success metrics for GMV and operator load.

TDD
Cover streaming ingestion, catalog grounding, reply guardrails, action auditability and rollback, latency budgets, and marketplace integrations.

How To Submit
Make Docs, Drive, Figma, GitHub, and deployed-app links viewable by AI Fund reviewers or anyone with the link. Repo access is required before your AI interview starts: make the repo public or add reviewer access with your submission — a zip snapshot is a fallback that pauses advancement until we can verify it.
Keep your full commit history; do not squash — your commit history is part of your submission and we read it.
Copy this reply template and fill in each line:

PRD:
TDD:
Prototype:
Source code:
Access notes / credentials:
What I personally built:
What I reused:
What the AI wrote, and what I rewrote or rejected:
What broke and how I debugged it:

Part 2: AI Interview
Required: After sending Part 1, complete a 60-minute voice interview with our AI interviewer.
Timing: Start within 30 minutes of sending your submission. Plan for the submission and interview as one sitting.
Availability: Your candidate-specific DeepInterview assignment is issued with this challenge and expires 72 hours after this email, 24 hours after the 48-hour build deadline.
What to expect: Walk through your prototype, key decisions, trade-offs, debugging process, and PRD/TDD. You will be asked to name exact files, functions, and commands from your submission — we reconcile these against your repo afterward, so have it open — and to produce a small piece of new logic out loud. AI tools are welcome on new questions if you narrate their use; questions about your own build should be answered from your own head. No additional preparation is needed, and none helps.
Access: Use your DeepInterview.AI invitation (noreply@deepinterview.org). Start only after submitting.
