# QitsSpaWorkspaces

The workspaces UI: what is in flight in a repository, and the one door that turns a workspace into
a release. Served by qits-workspaces itself at `/workspaces/` through Quinoa; it ships no image.

- **`/workspaces/`** — a repository's live workspaces, each with an **Integrate** action.

A repository has to be picked, and the reason is a service boundary rather than a screen someone
wanted: qits-workspaces' listing takes a mandatory `repositoryId` and owns no repository listing of
its own, so the picker is two reads against qits-projects. The choice rides in the query parameters
(`/workspaces/?project=…&repository=…`), so a repository you work in every day is a bookmark and the
back button means "the previous one".

## Integrating

Integrate merges a workspace's branch into the repository's default branch, stamps a CalVer version
onto it, and pushes — one commit whose subject is `release(<version>): <summary>`, where the summary
is the sentence the form asks for. **The target is not a parameter**: it is always the repository's
`mainBranch`, which is the whole feature. The request is `POST
/workspaces/api/workspaces/{id}/integrate` with `{summary}` and nothing else; the answer is
`{version, commitSha, branch}`.

The summary field previews the subject with the version left as `YYYY.MMDD.HHMMSS`, because the
stamp comes from the server's clock and any version rendered here first would be a number appearing
in no commit anywhere.

**The five outcomes are five surfaces, not one red box**, because each is a different thing to do
next:

| Outcome                 | What it means                                    | The way out                   |
| ----------------------- | ------------------------------------------------ | ----------------------------- |
| **Released**            | version, merge sha and branch                    | nothing — CI is building      |
| **Merge conflict**      | the branch does not apply; nothing was released  | resolve, then integrate again |
| **`main` moved**        | another integrate won the race; no version spent | press again, same summary     |
| **Already integrated**  | the branch is in; no second release was made     | refresh the list              |
| **Refused / no answer** | the service's own sentence, verbatim             | as it says                    |

The three middle rows all arrive as `409`. The platform's error envelope carries only `{"message"}`
today, so `integrate-outcome.ts` reads an optional structured `reason` (and an optional `conflicts`
file list) **first** and falls back to matching the message — and an unrecognised 409 is reported as
a refusal in the server's words rather than guessed into one of the three.

A release is recorded **above** the list, not in the row that produced it: integrating resolves the
workspace, so the next listing no longer contains it, and a success surface living in that row would
take the version and the merge sha off screen moments after producing them.

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
