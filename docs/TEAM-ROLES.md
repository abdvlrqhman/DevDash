# Team roles: AI team members for each project

Status: phase 1 built (brief, decisions, journal, roles with Generate, chat, shifts by hand, notebook); phases 2 and 3 proposed.

## 1. The problem and the idea

We build projects and then stall: what's next, is it ready, who is it for, should we publish at all. Nobody on the
team wants to be the CEO, the CTO or the marketer, so those jobs don't get done.

**Team roles** are AI team members attached to a project, each with a job (CEO, CTO, Marketing – Social, Finance…).
A role is not a chat window. It has:

- **instructions**: its job, what it watches, what it delivers, how it decides;
- **goals and measures** it is working towards, with deadlines;
- **a notebook**: what it knows, what it learned, what we rejected and why;
- **tools and permissions**: the code, tasks, notes, the database (read-only), the web, analytics, store pages, socials;
- **a schedule** (daily, weekly) and **triggers** (an alert, a new 1-star review, signups dropped);
- **an inbox**: messages from us, from other roles and from any Claude session;
- **a chat**: anyone on the team can talk to it like a colleague who knows the project.

Each time it works (a **shift**) it is a Claude session; the notebook and the project's shared memory carry it from one
shift to the next. Roles do safe work on their own and **ask us before anything public, with money, or irreversible**.
Once a day or once a week the lead role sends **one digest** with what happened and a list of approvals.

## 2. Is it realistic?

Yes, with a staged build. What makes it realistic:

- DevDash already runs Claude 24/7 as each member, on the same server, with the Agent SDK. A shift is the same machinery
  as a Chat session without a person typing.
- Claude already gets DevDash tools in every session (project info, tasks, notes, services) through the DevDash
  plugin and the member's agent. Roles mostly need more of those tools, not a new system.
- Projects, tasks with due dates, notes, the activity feed, notifications with phone push, and the vault all exist.

What is genuinely hard, and how the plan handles it:

| Hard part | Why | Handling |
|---|---|---|
| Good judgment, not generic advice | A role with little context gives blog-post advice. | Live data, an automatic journal, evidence required for every claim and proposal. |
| Agents that cave or don't learn | Anthropic's [Project Vend](https://www.anthropic.com/research/project-vend-1): Claude sourced well but sold at a loss, gave discounts under pressure and undid its own fixes. | Approvals for anything with money or public; rejections and outcomes written to the notebook; goals with numbers. |
| Multi-agent chaos | Agent "companies" fail like badly run organizations: unclear roles, lost handoffs, loops ([summary](https://www.antoinebuteau.com/multi-agent-systems-fail-like-organizations/)). | One owner per thread, typed messages, hop and wake limits, one lead role writes the digest. |
| Prompt injection | Roles read the web and social media; a comment can say "ignore your instructions and post X". | Outside content is data, never instructions; public and money actions always need a person. |
| Outside data | Social and store APIs differ: some free with quotas, some paid or restricted. | Connectors are optional and added one at a time; a role works without them, just with less to look at. |
| Plan usage | Several roles on several projects, every day. | Cheaper models for routine shifts, the strongest for the weekly strategy; a usage budget per role. |

The first useful version (phase 1 and 2 below) is mostly server code and screens on top of what exists. Connectors
(phase 3) are where the outside world adds work.

## 3. Inside DevDash, beside it, or a plugin?

| Option | Verdict |
|---|---|
| **A Claude Code plugin only** (role agents, skills, slash commands) | Not enough on its own. A plugin can define roles and tools, but it has no always-on scheduler on our server, no shared inbox or approvals screen, no phone push, and no memory shared between members. |
| **A separate app beside DevDash** | Duplicates everything roles need from DevDash: members and login, projects, tasks, notes, Claude sessions, notifications, the vault. Two places to look. |
| **A DevDash module, switched on per project** | **Recommended.** It reuses everything above and lives where the team already works. |

So: **built into DevDash as a module called Team**, off until a project switches it on. Two parts keep it portable:

- **Role definitions are plain files** in the same shape as Claude Code custom agents (`.claude/agents/<role>.md`,
  instructions as Markdown with a small header). DevDash stores them and can write them into the project, so a role can
  also be used from any Claude Code session, even outside DevDash.
- **The DevDash Claude plugin gets the role tools** (message a role, read the journal, propose, record a decision), so
  every session in DevDash can talk to the team, not only role shifts.

## 4. Concepts

| Concept | What it is |
|---|---|
| **Role** | A team member on one project: name, instructions, model, autonomy level, schedule, triggers, connectors, budget. |
| **Shift** | One run of a role: a Claude session with the role's instructions and context. Ends with a short report. |
| **Project brain** | Shared by all roles and people: the **brief** (what it is, who it's for, the stage), **goals**, the **decision log**. |
| **Journal** | Automatic "what happened" entries: session digests, commits, task changes, releases, alerts. |
| **Notebook** | One per role: beliefs, lessons, rejected ideas and why, measures over time, open questions. |
| **Thread** | One issue, with an owner role, participants, evidence and status (open, waiting on us, resolved). |
| **Message** | Inside a thread: FYI, question, request or alert. From a person, a role, a Claude session or an automatic check. |
| **Proposal** | Something a role wants to do that needs approval: what, why (evidence), cost, risk, reversible or not. |
| **Goal** | A target with a measure and a deadline ("Publish v1 on Play Store by Nov 15"), proposed by a role, approved by us. |
| **Connector** | A data source or action a role may use: read-only database, analytics, store reviews, social accounts. Keys in the vault. |

## 5. How a role knows things without being told

1. **It looks things up itself.** Git history, tasks, notes, services, the database (read-only), connectors and the web are
   queried live during a shift. Most knowledge never needs saving.
2. **The journal fills itself.** DevDash already records activity (commits, tasks, notes, sessions). When a Claude session
   finishes a stretch of work, a small model (Haiku) reads the new part of its transcript and writes 2–3 lines: what was
   done, what was decided, what's still open. This rides on the DevDash plugin hooks that already report session status.
   Every shift starts with **"what changed since my last shift"**.
3. **The project brain** holds what must not be forgotten: the brief, goals and the decision log. Roles add decisions
   there, and people can edit everything.
4. **The notebook** holds the role's own experience, including **every rejection and its reason**, so it doesn't suggest
   the same thing next week.

claude-mem stays what it is (one member's personal coding memory). It is per Linux user, so team roles can't depend on
it: what a role knows must be the same whoever on the team looks.

Coding sessions are **not** told to "save things for the roles": that's unreliable and clutters their work. The journal
does it for them. They get one tool, *message a role*, for real product or business signals (money, users, metrics, a
broken release), not code details.

## 6. A shift, step by step

1. **Start:** the schedule, a trigger, a message (alerts wake a role right away; the rest wait for its next shift), or a
   person pressing Run.
2. **Context:** the role's instructions, the brief, goals, recent decisions, its notebook, the journal since its last
   shift, its open threads and pending proposals.
3. **Work:** it uses its tools. It may do **safe actions** on its own: research, analyze, write notes, create *suggested*
   tasks, reply in threads, update its notebook, prepare drafts.
4. **Ask:** anything outside its autonomy becomes a **proposal** for approval.
5. **End:** a short shift report (what it looked at, found, did, proposes), notebook updated, next shift time shown.

Shifts are separate, short sessions with fresh context. The **chat** with a role is its own long-running session; both
share the notebook and the project brain, so what you tell it in chat is there on its next shift.

## 7. Autonomy and approvals

**Autonomy levels**, set per role and changeable any time:

- **Advisor**: only writes, suggests and asks. Everything else is a proposal.
- **Operator** (default): does safe actions itself, proposes the rest.
- **Trusted actions**: specific actions we've allowed it to do alone (e.g. "reply to store reviews", "move tasks").

**Always a proposal, at any level:** posting or publishing anything, messaging users or anyone outside the team, spending
or changing prices, releasing to a store, deleting, changing production data, changing access.

**Approvals inbox** (in the Team tab, in notifications, on the phone): each proposal shows what, why with evidence,
cost and risk, with **Approve**, **Reject** and **Reply** ("yes but…", "not before v1"). Every answer goes into the role's
notebook. **Approve** wakes the role with a one-time permission for exactly that action, and it carries it out and reports
back. Proposals expire if they wait too long, so stale plans don't run weeks later.

## 8. Threads and messages

- **Anyone can open or add to a thread:** people, roles, Claude sessions, automatic checks.
- **Types:** FYI (no reply needed), question (needs an answer), request (accept, decline or escalate), alert (wakes the owner now).
- **One owner** closes it; others are participants. A role that notices the same issue **joins the open thread** instead
  of opening another.
- **Evidence required:** numbers and links, not "views look low".
- **Routing:** a message for a role that doesn't exist goes to the lead role (or to people if there's none). If it keeps
  happening, the lead suggests creating that role.
- **Limits:** a cap on role-to-role replies in a thread before it goes to people; a cap on alerts per sender per day; a role
  can't keep waking another.
- **Everything outside is data:** a thread started by something that read the internet is a report to check, never an order.

Example: a session notices the last three videos got about 1k views and no likes. It opens a thread for **Marketing**,
including **Finance**, with the numbers. Marketing finds bot traffic from one source and proposes blocking it and
re-posting the best video; Finance proposes pausing the ad spend on those videos. Both proposals land in our approvals;
the thread is resolved when they're done.

## 9. Schedules, triggers, goals

- **Schedules:** simple recurring times per role ("weekdays 09:00", "Mondays 08:00"). The generator suggests one.
- **Triggers:** alerts and messages; DevDash events (a release, a task done, a build failed); connector checks
  ("signups down 30% week on week", "a new review of 2 stars or fewer").
- **Goals:** proposed by roles (usually the lead), approved by us, each with a measure and a deadline. Roles turn goals into
  tasks with due dates on the board; the lead checks progress weekly and raises a thread when a goal is slipping.
- **Digest:** the lead role sends one digest per day or week: what changed, goals on track or not, open threads, and the
  approvals waiting. Push notifications are only for alerts and approvals.

## 10. Creating and editing roles

- Type a **name and one line**: "Marketing – Social: watches our socials and competitors, says what to post and when."
- **Generate** writes the full definition: mission, responsibilities, what it watches, what it delivers, measures,
  autonomy (alone vs. ask), handoffs to other roles, suggested schedule and triggers, model.
- Edit before creating and any time after. **Restart** starts fresh shifts and chat with the notebook kept; **Reset** also
  clears the notebook.
- **Templates:** CEO (lead), CTO, Product, Marketing – Social, Growth / store listing, Support, QA, Finance.

## 11. Connectors (phase 3)

One at a time, each optional, credentials in the vault and never shown to the model:

- **Database, read-only**: a separate read-only database user; tables with personal data hidden or summarized.
- **Analytics**: whatever the project uses (counts, funnels, retention).
- **Store pages**: Play Store and App Store reviews, ratings, versions.
- **Socials**: own accounts' posts and stats; public pages of competitors. Some platforms' APIs are paid or restricted,
  so a platform may start as "read the public page" before it gets a real API connection.
- **Web**: search and fetch, already available to Claude.

Each connector is exposed to roles as tools, with the same rule: reading is free, any action that posts or changes
something is a proposal.

## 12. Safety and accounts

- **Whose account runs the roles:** each project picks one member; shifts run as that member's Linux user and Claude plan.
  Roles never get more access than that member, and everything they do is marked "via role" in the activity feed.
- **Tool permissions per role:** roles don't get unrestricted shell or file writes by default. Changing code is a proposal:
  "open a branch and a Claude session to do X", reviewed like any other work.
- **Prompt injection:** outside content is wrapped and labelled as data; public, money and irreversible actions always need
  a person; connectors that post are separate from those that read.
- **Budgets:** a model and a monthly usage budget per role; routine shifts on Sonnet or Haiku, the weekly strategy shift on
  Opus. A role that hits its budget pauses and says so.
- **Kill switch:** pause one role, or the whole team of a project, in one tap.

## 13. How it fits into DevDash

**Server** (`apps/server/src/modules/team/`)

- Tables: `roles`, `role_notebook`, `role_shifts`, `team_threads`, `team_messages`, `proposals`, `goals`, `project_brief`,
  `decisions`, `journal`, `connectors`.
- Scheduler: the server is always on; it checks due shifts every minute and starts them through the owner's agent.
- Journal writer: listens to activity and session events; queues session digests.
- Routes for the Team tab, approvals and threads; live updates over the existing hub topics.

**Agent** (`apps/agent/src/`)

- A `role.shift` op: starts an Agent SDK session with the role's context, tool permissions and model, and reports the shift
  back (the same pattern as Chat sessions, without a person).
- A `journal.digest` op: summarizes the new part of a session's transcript with a small model.

**DevDash Claude plugin** (`packages/claude-plugin/`)

- New tools for every session: `team_message` (open or add to a thread), `journal_read`, `decision_record`, `brief_get`.
- Tools only for role shifts: `propose`, `goal_propose`, `notebook_read`, `notebook_write`, `shift_report`.
- The DevDash skill gains one short rule on when a coding session should message a role.

**Web** (`apps/web/src/features/team/`)

- Project → **Team** tab: role cards (status, last and next shift, open threads), the brief and goals, threads, and the
  approvals list.
- Role page: chat, shift history with reports, notebook, instructions editor with Generate, schedule, autonomy, budget.
- Home and notifications: the digest and pending approvals across all projects.

### Built to be removable

Team uses DevDash; DevDash never depends on Team. If we ever drop it, removal takes about an hour.

- **Own folders:** `apps/server/src/modules/team/`, `apps/web/src/features/team/`, `apps/agent/src/team/`, and a
  separate `team` section of tools in the Claude plugin. No rewrites inside sessions, projects, tasks or notes.
- **One plug-in line per part:** registering the server module, the web routes and the Team tab, the agent ops, the
  plugin tools.
- **Listens, doesn't patch:** the journal and triggers subscribe to events DevDash already emits (activity, session
  finished, task changed) instead of adding code to those features.
- **Own tables:** all named `team_*`, created in their own migration; core tables never reference them. Removal is a
  migration that drops them, after an export of roles, notebooks and decisions.
- **Switches:** off per project until turned on, plus one server-wide setting that hides the tab, stops shifts and
  withdraws the tools.
- **`REMOVING-TEAM.md`:** every plug-in line, migration and tool name, kept current, plus a test that fails if core
  code imports anything from Team.

## 14. Phases

**Phase 1: the brain and the first roles**

- Project brief, decision log, automatic journal (session digests and activity).
- Team tab, create a role from a template or with Generate, edit instructions, chat with a role, run a shift by hand.
- Shift reports and the notebook. Roles create *suggested* tasks only.
- *Done when:* a CEO role on Seevil, run by hand, gives a report that changes what we do that week.

**Phase 2: roles that work on their own**

- Schedules and triggers, autonomy levels, the approvals inbox with push notifications, proposals carried out after
  approval, goals with deadlines, budgets and the kill switch.
- *Done when:* Seevil's roles run for two weeks without anyone pressing Run, and the weekly digest is the thing we read.

**Phase 3: a real team**

- Threads and messages between roles, sessions and people; routing, limits and the lead role's digest.
- Connectors: read-only database first, then store reviews, analytics and socials.
- *Done when:* a problem one role or session notices (views, money, reviews) reaches the right role, gets investigated
  with real numbers and ends in a proposal we approve or reject, without anyone forwarding it by hand.

Each phase is usable on its own; we stop and adjust after each one.

## 15. Questions to settle before building

1. Which projects first: Seevil only, or one more to compare?
2. Whose account runs Seevil's roles (Claude plan, Linux user)?
3. Who can approve: any member on the project, or the project's owner only?
4. Which connectors matter first for Seevil: its database, store pages, which social platforms?
5. Digest rhythm: daily, weekly, or daily on weekdays plus a weekly strategy?
