import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { QitsButton } from '@qits/ui-components';
import { QITS_API_BASE } from '../../api/api-base';
import type { ServiceDto } from '../../api/services-api';
import { WorkspaceServices } from '../../api/workspace-services';
import { Empty } from '../../ui/empty';

/** The states in which a declared service is worth framing. Anything else has nothing listening. */
const LIVE: readonly ServiceDto['state'][] = ['STARTING', 'READY', 'RESTARTING'];

/**
 * The Web view tab: the workspace's own application, framed.
 *
 * ## Same origin, on purpose
 *
 * The frame is served through `/workspaces/service/{workspaceRowId}/{serviceId}/`, which is
 * qits-workspaces' own proxy — so the framed app and this page share an origin. That is not a
 * convenience: it is what lets the toolbar read the framed window's **live** location as the user
 * navigates inside the app, and it is what the element picker needs to exist at all. A frame on
 * another origin is still a usable frame; it is just opaque, and the toolbar says so instead of
 * showing a path that stopped being true three clicks ago.
 *
 * The path is built here rather than by the daemon, and the daemon says why: it is a shape over ids
 * the daemon is not the authority on. `webView` is the checkout's declaration and nothing more —
 * `basePath` is what the app was built to be served under and `entryPath` is where to land.
 *
 * ## What it loads
 *
 * **On first selection this panel reads `1`, and only when nothing has asked yet**: the shared
 * services entry, which also colours the Services tab's dot and fills its panel. The frame itself is
 * a document load rather than an API read, and it happens once — the panel latches on first
 * selection and then only hides, so switching tabs never reloads the app you were using.
 */
@Component({
  selector: 'app-web-view-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Empty, QitsButton],
  templateUrl: './web-view-panel.html',
  styleUrl: './web-view-panel.css',
})
export class WebViewPanel {
  private readonly entry = inject(WorkspaceServices);
  private readonly apiBase = inject(QITS_API_BASE);
  private readonly sanitizer = inject(DomSanitizer);

  readonly workspaceRowId = input.required<number>();

  protected readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  /** Which service is framed. A free level: it dies with the panel, so it is a local signal. */
  protected readonly chosen = signal<string | null>(null);

  /** Whether the URL bar is open. Opening it swaps the rest of the toolbar for the input. */
  protected readonly barOpen = signal(false);

  /** What the input holds, and what it held when the bar was opened — the reset target. */
  protected readonly barValue = signal('');
  private openedWith = '';

  /** What went wrong with a typed path. */
  protected readonly barProblem = signal<string | null>(null);

  /** Bumped on every frame load, so anything reading the framed location re-reads it. */
  protected readonly loads = signal(0);

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      this.entry.use(workspaceRowId);
    });

    // A service that goes away takes the selection with it; a first live one takes it up.
    effect(() => {
      const framable = this.framable();
      const chosen = this.chosen();
      if (framable.length === 0) {
        return;
      }
      if (!chosen || !framable.some((service) => idOf(service) === chosen)) {
        this.chosen.set(idOf(framable[0]));
      }
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  protected readonly services = this.entry.services;

  /** Declared web-viewable **and** live. Both halves matter: a stopped service frames a 502. */
  protected readonly framable = computed<readonly ServiceDto[]>(() => {
    const state = this.services();
    if (state.kind !== 'ready') {
      return [];
    }
    return state.value.filter((service) => service.webViewable && LIVE.includes(service.state));
  });

  /** Web-viewable but not running — the difference between "nothing to show" and "start it". */
  protected readonly stopped = computed<readonly ServiceDto[]>(() => {
    const state = this.services();
    if (state.kind !== 'ready') {
      return [];
    }
    return state.value.filter((service) => service.webViewable && !LIVE.includes(service.state));
  });

  protected readonly service = computed<ServiceDto | null>(() => {
    const chosen = this.chosen();
    return this.framable().find((service) => idOf(service) === chosen) ?? null;
  });

  /** The proxy prefix this workspace's service is served under, with its trailing slash. */
  protected readonly proxyBase = computed(() => {
    const service = this.service();
    if (!service) {
      return '';
    }
    return `${this.apiBase}/workspaces/service/${this.workspaceRowId()}/${encodeURIComponent(idOf(service))}/`;
  });

  /** Where the frame lands: the proxy prefix, then the declaration's base and entry paths. */
  protected readonly frameUrl = computed(() => {
    const service = this.service();
    if (!service) {
      return null;
    }
    return this.proxyBase() + appPath(service.webView?.basePath, service.webView?.entryPath);
  });

  /**
   * The same URL, trusted.
   *
   * Angular sanitizes an `iframe`'s `src` as a resource URL and refuses a plain string. Trusting this
   * one is not a shortcut: **it is a path this component built**, from the API base, this page's own
   * workspace row id and an encoded service id — there is no user-supplied origin anywhere in it, and
   * a typed path goes through {@link navigate}, which refuses anything carrying a scheme.
   */
  protected readonly frameSrc = computed<SafeResourceUrl | null>(() => {
    const url = this.frameUrl();
    return url === null ? null : this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  /**
   * The route the framed app is on **right now**, with the proxy prefix stripped.
   *
   * Read from the framed window rather than remembered from the source, so it tracks navigation
   * inside the app. A foreign-origin frame throws on the read and answers null, which the toolbar
   * renders as its own state rather than as an empty box.
   */
  protected readonly livePath = computed<string | null>(() => {
    this.loads();
    const element = this.frame()?.nativeElement;
    if (!element) {
      return null;
    }
    try {
      const location = element.contentWindow?.location;
      if (!location || location.href === 'about:blank') {
        return null;
      }
      const here = `${location.pathname}${location.search}${location.hash}`;
      const base = this.proxyBase();
      return here.startsWith(base) ? here.slice(base.length) : here;
    } catch {
      // Cross-origin. The frame still works; this page simply cannot see where it is.
      return null;
    }
  });

  /** Whether this page can see inside the frame at all. The picker's precondition, and the bar's. */
  protected readonly sameOrigin = computed(() => {
    this.loads();
    const element = this.frame()?.nativeElement;
    if (!element) {
      return false;
    }
    try {
      return element.contentDocument !== null;
    } catch {
      return false;
    }
  });

  protected label(service: ServiceDto): string {
    return service.description ? `${service.name} — ${service.description}` : service.name;
  }

  protected idOf(service: ServiceDto): string {
    return idOf(service);
  }

  // ---- what the panel does -----------------------------------------------------------------

  protected choose(serviceId: string): void {
    this.chosen.set(serviceId);
    this.barOpen.set(false);
  }

  protected onFrameLoad(): void {
    this.loads.update((count) => count + 1);
  }

  /**
   * Open or close the URL bar.
   *
   * Opening seeds the input from the frame's *current* path, so it says where the app actually is.
   * **Closing discards**, which is why the opened value is kept: an edit that was never navigated to
   * must not survive as a claim about the frame.
   */
  protected toggleBar(): void {
    const open = !this.barOpen();
    this.barOpen.set(open);
    this.barProblem.set(null);
    if (open) {
      this.openedWith = this.livePath() ?? appPathOf(this.service());
      this.barValue.set(this.openedWith);
    }
  }

  protected resetBar(): void {
    this.barValue.set(this.openedWith);
    this.barProblem.set(null);
  }

  /**
   * Navigate the frame.
   *
   * An **in-frame location change**, not a new `src`: the app keeps whatever it holds that survives a
   * route change, and the load hook fires exactly as it would for a link inside the app — which is
   * what makes the picker re-attach through one code path rather than two.
   */
  protected navigate(): void {
    const typed = this.barValue().trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(typed) || typed.startsWith('//')) {
      this.barProblem.set('Only a path inside this application, not another address.');
      return;
    }
    const element = this.frame()?.nativeElement;
    if (!element) {
      return;
    }
    const target = this.proxyBase() + typed.replace(/^\/+/, '');
    this.barProblem.set(null);
    try {
      const window = element.contentWindow;
      if (window) {
        window.location.assign(target);
        return;
      }
    } catch {
      // Cross-origin: the frame cannot be driven from here, so replace it wholesale instead.
    }
    element.src = target;
  }
}

/** The segment the proxy path is built from: the declared id, falling back to the name. */
function idOf(service: ServiceDto): string {
  return service.id ?? service.name;
}

/** `basePath` and `entryPath` joined into one relative path, with the slashes sorted out once. */
function appPath(basePath: string | undefined, entryPath: string | undefined): string {
  const base = (basePath ?? '').replace(/^\/+|\/+$/g, '');
  const entry = (entryPath ?? '').replace(/^\/+/, '');
  if (!base) {
    return entry;
  }
  return entry ? `${base}/${entry}` : `${base}/`;
}

function appPathOf(service: ServiceDto | null): string {
  return service ? appPath(service.webView?.basePath, service.webView?.entryPath) : '';
}
