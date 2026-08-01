# QitsSpaWorkspaces

The workspaces UI: what is in flight in a repository, and the two doors that send a workspace home.
Served by qits-workspaces itself at `/workspaces/` through Quinoa; it ships no image.

- **`/workspaces/`** — a repository's live workspaces, each with the one action its branch calls
  for: **Release** or **Integrate**.

A repository has to be picked, and the reason is a service boundary rather than a screen someone
wanted: qits-workspaces' listing takes a mandatory `repositoryId` and owns no repository listing of
its own, so the picker is two reads against qits-projects. The choice rides in the query parameters
(`/workspaces/?project=…&repository=…`), so a repository you work in every day is a bookmark and the
back button means "the previous one".

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
