# QitsSpaWorkspaces

The workspaces UI: what is in flight in a repository, and the two doors that send a workspace home.
Served by qits-workspaces itself at the root of its own host (`workspaces.<env>.<domain>/`) through
Quinoa; it ships no image.

- **`/`** — a repository's live workspaces, each with the one action its branch calls
  for: **Release** or **Integrate**.
- **`/repositories/{repositoryId}/workspaces/{id}?tab=…`** — one workspace's detail view:
  the room you sit in while a coding agent changes it.

Both answer at a **scoped** address too — `/<projectSlug>/<group>/<repoName>/…`, the middle
segment being the repository's component where the platform gives it one and its archetype category
where it does not — which is the
platform-wide URL grammar every SPA here shares. The pages read that scope from
`@qits/ui-components` rather than from route parameters, so one component serves both spellings.

A repository has to be named, and the reason is a service boundary rather than a screen someone
wanted: qits-workspaces' listing takes a mandatory `repositoryId` and owns no repository listing of
its own. **Scoped, the address names it**: the repository in the URL, or — for a project with no
repository named — that project's wrapper, which is the row an aggregate workspace branches. The
picker is not drawn then, because it could only contradict the URL. **Unscoped it is still the way
in**: two reads against qits-projects, one wrapper per project, and `?repository=<id>` preselects
one so the projects SPA can link straight to a project's own create.

## The detail view

The shell, so far: the header, the status strip, the activity bar, the tab row and its contract, the
transient Starting tab, and the live channel. The six panels land one workstream each; each tab says
which one until it does.

**It reads three things and opens one stream.** The repository (for its default branch, which is
what decides the door home), the repository's workspace list (one entry feeds the header, the strip
**and** the activity bar), and the workspace's active technical process. Then one `EventSource` on
`/workspaces/api/workspaces/{id}/events`. Nothing on the page polls: the channel carries payload-free
topic names, each panel re-fetches through the ordinary REST endpoints when its topic ticks, and an
idle workspace produces no traffic at all. A fourth read happens in exactly one case — the id is not
in the active list, which means the work has resolved.

**On every connect and every reconnect, everything is invalidated once.** There is no replay
protocol, no `Last-Event-ID` and no resume token, because the server offers none; the browser's own
reconnect handles the retry and one burst of requests closes the gap. It costs a duplicate burst on
the very first connect and removes an entire class of bugs where the page is quietly wrong about
something it stopped hearing.

**Hidden tabs stay mounted.** A panel is created the first time its tab is selected and only hidden
after that (`@if (latched)` inside a `[style.display]` wrapper), so a chat socket, a framed
application, an open file and every scroll position survive a tab switch. Dragging a tab moves the
button and nothing else, because the strip and the panel container are two loops with two orders —
moving a panel in the document would reload its iframe. Tab order is per-session and deliberately not
stored: it is device ergonomics, unlike the prompt draft, which is work product and lives on the
server.

**Which tab is open is a query parameter**, not a trailing path segment. A trailing segment would
make a _workspace_ switch reuse the page too, which is a bug rather than a feature; `?tab=` keeps the
path meaning "which workspace", makes a bare URL mean "no tab pinned" by simple absence, and keeps
every tab a shareable link. An unknown slug is normalised away; a bare URL is never filled in. A
workspace change is still a path change under one route config, so the page carries an explicit
remount guard.

**The status strip is where the state and the verbs live.** Runtime state and its error, the daemon's
connection, version and outdated warning, clean/dirty, ahead/behind, and the resolution — every field
was already on the wire and the old screen ignored all of them. Start, Stop and Recreate sit next to
the runtime state; the one door home and Discard sit next to the resolution. Two rules are load-bearing:

- **Recreate is disabled unless the tree is provably clean.** The service refuses with a 400
  otherwise, and `clean: null` — what a workspace with no live daemon reports — counts as not clean.
  That combination is the point: recreate is the remedy for an outdated daemon, and an outdated daemon
  is often a disconnected one.
- **A missing daemon is a sentence, not seven 502s.** The reverse tunnel made the daemon's control
  socket load-bearing for the container proxy, so a blip takes the file browser, every terminal and
  the whole agent surface down at once. A dropped _hint channel_ is a different size of problem and
  gets a quiet inline marker instead: the page is briefly behind and will catch up.

**The activity bar sorts by recency, and that is its whole point.** Buttons order by when each
workspace's agent activity last changed, most recent first, ties by id — so a session that has just
stopped sorts to the far left, which is exactly the workspace waiting for your next prompt. The
timestamps are client-side memory held at application scope; page-scoped memory would re-shuffle the
row every time you clicked one of its own buttons.

**The browser talks to the in-container daemon directly**, through the verbatim proxy at
`/workspaces/container/{id}/*`, with hand-written typed clients. The proxy rewrites no path and sets
the daemon's bearer itself, and the SPA is same-origin with it, so the gateway session cookie is the
whole auth story. The line that settles it: _the proxy carries everything the daemon owns, the host
serves only what the host owns, and nothing forwards._ `WorkspaceDaemonApi` is the transport; each
panel's typed client is written against the daemon's own contract by the workstream that needs it.

**A resolved workspace does not get a detail view.** It is not in the active list, its container is
gone, and the history record has no branch state, no runtime and no commands — six tabs that all 502
would be worse than an honest record, which is what the page shows instead.

## Releasing and integrating

**Two processes, not one action with a toggle.**

| Door          | Request                                      | Lands on                      | Commit subject                   | Answer                              |
| ------------- | -------------------------------------------- | ----------------------------- | -------------------------------- | ----------------------------------- |
| **Release**   | `POST …/workspaces/{id}/release {summary}`   | the repository's `mainBranch` | `release(<version>): <summary>`  | `{version, commitSha, branch}`      |
| **Integrate** | `POST …/workspaces/{id}/integrate {summary}` | the workspace's parent branch | `integrate(<branch>): <summary>` | `{commitSha, branch, targetBranch}` |

Release merges, stamps a CalVer version and pushes — one commit carrying both. It is the only way
into the default branch. Integrate is a plain merge into the parent: a `task/*` workspace lands on
its `epic/*`, no version is stamped and nothing is published; the epic is what gets released later.

**Neither request names a target.** Release always lands on `mainBranch` and integrate always lands
on the parent, and both are facts the service already holds — so a client that could name a target
would be describing an API that does not exist.

**A row offers one door, not two.** Which one is read from the workspace's `parent`: parented on
`mainBranch` means release, anything else means integrate. That reading is the client's and never
the authority — an integrate aimed at the default branch is refused with a `409` naming the release
door, so a stale list produces a clear refusal instead of a wrong merge.

The summary field previews the subject it will write. A release's version is left as
`YYYY.MMDD.HHMMSS`, because the stamp comes from the server's clock and any version rendered here
first would be a number appearing in no commit anywhere. An integrate's scope is the source branch,
which is already known, so that preview is exact.

**The six outcomes are six surfaces, not one red box**, because each is a different thing to do
next. Both doors share them, because both answer out of the same `409` family:

| Outcome                 | What it means                                                 | The way out               |
| ----------------------- | ------------------------------------------------------------- | ------------------------- |
| **Landed**              | merge sha, branch and target — plus the version, on a release | nothing — CI is building  |
| **Merge conflict**      | the branch does not apply; nothing landed                     | resolve, then press again |
| **Target moved**        | another merge won the race; no version spent                  | press again, same summary |
| **Already integrated**  | the branch is in; nothing was done twice                      | refresh the list          |
| **Release required**    | the target is the default branch, which has one door          | the release door, offered |
| **Refused / no answer** | the service's own sentence, verbatim                          | as it says                |

The four middle rows all arrive as `409`. The platform's error envelope carries only `{"message"}`
today, so `merge-outcome.ts` reads an optional structured `reason` (and an optional `conflicts` file
list) **first** and falls back to matching the message — and an unrecognised 409 is reported as a
refusal in the server's words rather than guessed into one of the others. `PUSH_REJECTED` is a
refusal and deliberately not a lost race: the family spells that `NOT_FAST_FORWARD`, so a declared
push rejection is the git host saying no for a reason "press it again" cannot fix.

`RELEASE_REQUIRED` is the one 409 with a button rather than a sentence. It is qits-workspaces'
main-target guard, thrown by both endpoints, and it means the row read a `parent` that has since
moved on — nothing is wrong with the work. The surface offers **Release into `<main>` instead**,
which overrules the row's own reading and returns to the summary with the sentence intact and the
release subject in the preview. It stops there rather than sending: the press being offered stamps a
version and publishes, which is not the act that was asked for, so it is confirmed by one more
press. Meeting the guard on the release door itself offers the summary back instead, because
"release instead" would be advice to redo what just failed.

What landed is recorded **above** the list, not in the row that produced it: a merge resolves the
workspace, so the next listing no longer contains it, and a success surface living in that row would
take the sha — and the version, when there is one — off screen moments after producing them. An
integrate has no version, so its record and its surface draw none rather than an empty slot.

`src/app/api/` holds hand-written interfaces mirroring the two services' wire shapes, one injectable
service each, over `HttpClient` on the fetch backend. Nothing is generated, and nothing is shared
with qits-spa-ci or qits-spa-cd: the duplication is the deliberate alternative to putting transport
into a components library that seven SPAs consume without making a request.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.19.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

`proxy.conf.json` forwards `/workspaces/api` and `/projects/api` to a gateway on `localhost:8080`,
because `ng serve` puts no gateway in front and the screen reads across two services. In a
deployment every call is a same-origin path behind the real gateway, which is what carries the
session cookie.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

Integrated by the release flow (AC live proof, 2026-07-31T21:32:31Z).
