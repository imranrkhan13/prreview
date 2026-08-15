import { useEffect, useRef, useState, ReactNode } from "react";
import { githubLoginUrl } from "../api";
import { DeploymentTimeline } from "./DeploymentTimeline";
import "./landing.css";

export function LandingPage() {
  return (
    <div className="landing">
      <Navbar />
      <Hero />
      <ProblemSection />
      <HowItWorks />
      <ProductDemoSection />
      <LifecycleSection />
      <SecuritySection />
      <PersonasSection />
      <DxSection />
      <BetaSection />
      <FaqSection />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ---------- Reveal-on-scroll wrapper ---------- */

function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${visible ? "reveal--visible" : ""}`}>
      {children}
    </div>
  );
}

/* ---------- Navbar ---------- */

function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <nav className={`landing-nav ${scrolled ? "landing-nav--scrolled" : ""}`} aria-label="Main">
        <a href="#top" className="landing-nav__wordmark">
          prpreview
        </a>
        <ul className="landing-nav__links">
          <li>
            <a href="#product-demo">Product</a>
          </li>
          <li>
            <a href="#how-it-works">How it works</a>
          </li>
          <li>
            <a href="#security">Security</a>
          </li>
          <li>
            <a href="#faq">FAQ</a>
          </li>
        </ul>
        <div className="landing-nav__actions">
          <a href={githubLoginUrl()} className="landing-nav__signin">
            Sign in
          </a>
          <a href={githubLoginUrl()} className="btn btn--primary btn--small">
            Continue with GitHub
          </a>
          <button
            className="landing-nav__menu-toggle"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? "✕" : "☰"}
          </button>
        </div>
      </nav>
      {mobileOpen && (
        <div className="landing-nav__mobile-panel">
          <a href="#product-demo" onClick={() => setMobileOpen(false)}>
            Product
          </a>
          <a href="#how-it-works" onClick={() => setMobileOpen(false)}>
            How it works
          </a>
          <a href="#security" onClick={() => setMobileOpen(false)}>
            Security
          </a>
          <a href="#faq" onClick={() => setMobileOpen(false)}>
            FAQ
          </a>
          <a href={githubLoginUrl()}>Sign in</a>
        </div>
      )}
    </>
  );
}

/* ---------- Hero ---------- */

function Hero() {
  return (
    <header id="top" className="hero">
      <div className="landing__grid-bg" aria-hidden="true" />
      <div className="landing__container hero__grid">
        <div>
          <p className="landing__eyebrow">Public beta</p>
          <h1 className="landing__heading" style={{ fontSize: "clamp(32px, 5vw, 48px)" }}>
            Every pull request deserves a real environment.
          </h1>
          <p className="landing__subtext">
            PRPreview automatically deploys a live, shareable environment for every pull request —
            so your team can review working software before it merges.
          </p>
          <div className="hero__ctas">
            <a href={githubLoginUrl()} className="btn btn--primary">
              Continue with GitHub
            </a>
            <a href="#product-demo" className="btn btn--secondary">
              View live demo
            </a>
          </div>
          <p className="hero__trust">Public beta · GitHub-native · Automatic cleanup</p>
        </div>
        <div>
          <DeploymentTimeline
            prNumber={42}
            branch="feature/checkout-redesign"
            commitSha="a8f21c7"
            previewSlug="checkout-redesign-pr42"
          />
        </div>
      </div>
    </header>
  );
}

/* ---------- Problem / solution ---------- */

function ProblemSection() {
  return (
    <section className="landing__section" aria-labelledby="problem-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="problem-heading">
              Review code. And the product it creates.
            </h2>
            <p className="landing__subtext">
              Most pull requests are reviewed through diffs, screenshots, a local checkout, or a
              shared staging environment nobody quite trusts. With PRPreview, every PR becomes a
              working URL.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className="compare">
            <div className="compare__col compare__col--without">
              <p className="compare__label">Without PRPreview</p>
              <ol className="compare__flow">
                <li>PR opened</li>
                <li>Reviewer reads code</li>
                <li>Runs project locally</li>
                <li>Configures environment</li>
                <li>Maybe sees the feature</li>
              </ol>
            </div>
            <div className="compare__col compare__col--with">
              <p className="compare__label">With PRPreview</p>
              <ol className="compare__flow">
                <li>PR opened</li>
                <li>Preview automatically deploys</li>
                <li>Reviewer clicks the URL</li>
                <li>Reviews working software</li>
              </ol>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- How it works ---------- */

const HOW_IT_WORKS_STEPS = [
  {
    title: "Connect GitHub",
    body: "Install the PRPreview GitHub App and select your repositories.",
  },
  {
    title: "Open a pull request",
    body: "PRPreview detects the PR and queues a deployment automatically.",
  },
  {
    title: "Share the preview",
    body: "A public preview URL appears once health checks pass.",
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="landing__section landing__section--tight" aria-labelledby="how-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="how-heading">
              How it works
            </h2>
          </div>
        </Reveal>
        <Reveal>
          <div className="steps">
            {HOW_IT_WORKS_STEPS.map((step, i) => (
              <div className="step-card" key={step.title}>
                <p className="step-card__number">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="step-card__title">{step.title}</h3>
                <p className="step-card__body">{step.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Product demo ---------- */

const DEPLOY_STAGES = ["Queued", "Provisioning", "Deploying", "Health check", "Live"];

function ProductDemoSection() {
  return (
    <section id="product-demo" className="landing__section" aria-labelledby="demo-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="demo-heading">
              This is what your team will see
            </h2>
            <p className="landing__subtext">
              A real deployment, not a mockup of one — the same states and events the dashboard
              shows for every pull request.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className="demo-panel">
            <div className="demo-panel__topbar">
              <span className="demo-panel__repo mono">acme/checkout</span>
              <span className="demo-panel__pr">#42 Checkout redesign</span>
            </div>
            <div className="demo-panel__body">
              <div className="demo-panel__col">
                <p className="demo-panel__col-title">Deployment</p>
                <div className="demo-panel__row">
                  <span className="demo-panel__row-label">Commit</span>
                  <span className="demo-panel__row-value mono">a8f21c7</span>
                </div>
                <div className="demo-panel__row">
                  <span className="demo-panel__row-label">Status</span>
                  <span
                    className="demo-panel__row-value"
                    style={{ color: "var(--status-live)", fontWeight: 600 }}
                  >
                    Live
                  </span>
                </div>
                <div className="demo-panel__row">
                  <span className="demo-panel__row-label">Stages</span>
                  <span className="demo-panel__row-value" style={{ textAlign: "right" }}>
                    {DEPLOY_STAGES.join(" → ")}
                  </span>
                </div>
                <div className="demo-panel__row">
                  <span className="demo-panel__row-label">Preview</span>
                  <span className="demo-panel__row-value" style={{ color: "var(--brand)" }}>
                    Open preview ↗
                  </span>
                </div>
              </div>
              <div className="demo-panel__col">
                <p className="demo-panel__col-title">Activity</p>
                <ul className="demo-panel__activity">
                  <li>
                    <span className="demo-panel__activity-dot" />
                    Webhook received
                  </li>
                  <li>
                    <span className="demo-panel__activity-dot" />
                    Worker claimed deployment
                  </li>
                  <li>
                    <span className="demo-panel__activity-dot" />
                    Railway service created
                  </li>
                  <li>
                    <span className="demo-panel__activity-dot" />
                    Health check passed
                  </li>
                  <li>
                    <span className="demo-panel__activity-dot" />
                    Preview ready
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Lifecycle ---------- */

const LIFECYCLE_ITEMS = [
  { trigger: "PR opened", result: "Preview created" },
  { trigger: "New commit pushed", result: "Preview updated" },
  { trigger: "PR closed / merged", result: "Preview destroyed" },
  { trigger: "TTL expires", result: "Preview cleaned up automatically" },
];

function LifecycleSection() {
  return (
    <section className="landing__section landing__section--tight" aria-labelledby="lifecycle-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="lifecycle-heading">
              The preview lifecycle is fully automatic
            </h2>
          </div>
        </Reveal>
        <Reveal>
          <div className="lifecycle">
            {LIFECYCLE_ITEMS.map((item) => (
              <div className="lifecycle__item" key={item.trigger}>
                <p className="lifecycle__trigger mono">{item.trigger}</p>
                <p className="lifecycle__result">{item.result}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Security ---------- */

const SECURITY_ITEMS = [
  "GitHub webhook HMAC verification",
  "Authenticated GitHub onboarding",
  "Organization isolation",
  "Explicit repository opt-in",
  "Fork PR approval",
  "Secret allowlists",
  "Health-gated deployments",
  "Concurrency controls and kill switch",
  "Automatic teardown and deployment TTL",
];

function SecuritySection() {
  return (
    <section id="security" className="landing__section" aria-labelledby="security-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="security-heading">
              Built to run untrusted code carefully.
            </h2>
            <p className="landing__subtext">
              PRPreview deploys code from pull requests, including from people your team hasn't
              vetted. These are the controls actually in place.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className="security-grid">
            {SECURITY_ITEMS.map((item) => (
              <div className="security-item" key={item}>
                <span className="security-item__mark" aria-hidden="true">
                  ✓
                </span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <p className="security-note">
            PRPreview currently uses container-based preview execution and is in public beta.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Personas ---------- */

const PERSONAS = [
  { title: "Engineering teams", body: "Review features without local setup." },
  { title: "Founders", body: "Share working PRs with stakeholders." },
  { title: "Designers", body: "Review actual UI instead of screenshots." },
  { title: "QA", body: "Test each PR independently." },
  { title: "Open-source maintainers", body: "Safely approve fork previews before deployment." },
];

function PersonasSection() {
  return (
    <section className="landing__section landing__section--tight" aria-labelledby="personas-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="personas-heading">
              Built for teams
            </h2>
          </div>
        </Reveal>
        <Reveal>
          <div className="personas">
            {PERSONAS.map((p) => (
              <div key={p.title}>
                <h3 className="persona__title">{p.title}</h3>
                <p className="persona__body">{p.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Developer experience ---------- */

const DX_ITEMS = [
  "GitHub-native, no custom CI pipeline required for basic use",
  "Automatic health checks",
  "Public HTTPS preview URLs",
  "Automatic teardown",
  "Repository-level controls",
  "Fork approval gates",
  "Deployment activity timeline",
  "No manual API key copy/paste for normal users",
];

function DxSection() {
  return (
    <section className="landing__section landing__section--tight" aria-labelledby="dx-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="dx-heading">
              Developer experience
            </h2>
          </div>
        </Reveal>
        <Reveal>
          <ul className="dx-list">
            {DX_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Public beta ---------- */

function BetaSection() {
  return (
    <section className="landing__section" aria-labelledby="beta-heading">
      <div className="landing__container">
        <Reveal>
          <div className="beta-panel">
            <h2 className="landing__heading" id="beta-heading" style={{ marginBottom: 8 }}>
              PRPreview is now in public beta.
            </h2>
            <p className="landing__subtext" style={{ margin: "0 auto" }}>
              Connect GitHub, enable a repo, open a PR, get your preview.
            </p>
            <div className="beta-panel__steps">
              <span>Connect GitHub</span>
              <span className="beta-panel__arrow">→</span>
              <span>Enable a repo</span>
              <span className="beta-panel__arrow">→</span>
              <span>Open a PR</span>
              <span className="beta-panel__arrow">→</span>
              <span>Get your preview</span>
            </div>
            <a href={githubLoginUrl()} className="btn btn--primary">
              Continue with GitHub
            </a>
            <p className="landing__subtext" style={{ margin: "20px auto 0", fontSize: 13, maxWidth: 480 }}>
              Public beta means we are actively improving provider support, isolation, and
              reliability based on real usage.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- FAQ ---------- */

const FAQ_ITEMS = [
  { q: "What is PRPreview?", a: "A tool that automatically deploys a live, shareable environment for every pull request, so reviewers can use the real thing instead of reading a diff." },
  { q: "Does every repository deploy automatically?", a: "No. Repositories must be explicitly enabled before any preview is created." },
  { q: "Are preview URLs public?", a: "Yes, generated preview URLs are publicly accessible so anyone with the link can open them — no PRPreview account required." },
  { q: "Does the dashboard require authentication?", a: "Yes, GitHub login is required to view or manage anything in the dashboard." },
  { q: "What happens when I close a PR?", a: "The preview environment is torn down automatically." },
  { q: "What about fork PRs?", a: "Fork PRs require explicit approval from a repository admin before they deploy." },
  { q: "Can preview apps access my PRPreview secrets?", a: "No infrastructure credentials are injected into preview environments. Only env vars a repository owner explicitly allowlists are passed through." },
  { q: "Which deployment provider is supported?", a: "Railway currently powers public preview environments." },
  { q: "Do you support every repository or framework?", a: "Not yet. A repository needs a .prpreview/Dockerfile at its root that builds the app and listens on port 3000." },
  { q: "Is this production ready?", a: "PRPreview is in public beta, not enterprise production maturity. We're actively improving provider support, isolation, and reliability based on real usage." },
];

function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" className="landing__section" aria-labelledby="faq-heading">
      <div className="landing__container">
        <Reveal>
          <div className="landing__section-head">
            <h2 className="landing__heading" id="faq-heading">
              Frequently asked questions
            </h2>
          </div>
        </Reveal>
        <Reveal>
          <div className="faq">
            {FAQ_ITEMS.map((item, i) => {
              const isOpen = openIndex === i;
              return (
                <div className="faq-item" key={item.q} data-open={isOpen}>
                  <button
                    className="faq-item__q"
                    aria-expanded={isOpen}
                    aria-controls={`faq-answer-${i}`}
                    onClick={() => setOpenIndex(isOpen ? null : i)}
                  >
                    {item.q}
                    <span className="faq-item__icon" aria-hidden="true">
                      +
                    </span>
                  </button>
                  {isOpen && (
                    <p className="faq-item__a" id={`faq-answer-${i}`}>
                      {item.a}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Final CTA ---------- */

function FinalCta() {
  return (
    <section className="final-cta" aria-labelledby="final-cta-heading">
      <div className="landing__container">
        <h2 className="landing__heading" id="final-cta-heading" style={{ fontSize: "clamp(28px, 4vw, 40px)" }}>
          Stop reviewing features through screenshots.
        </h2>
        <p className="landing__subtext" style={{ margin: "0 auto" }}>
          Open the PR. Click the preview. Review the real thing.
        </p>
        <div className="final-cta__ctas">
          <a href={githubLoginUrl()} className="btn btn--primary">
            Continue with GitHub
          </a>
          <a href={githubLoginUrl()} className="btn btn--secondary">
            View GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

/* ---------- Footer ---------- */

function Footer() {
  return (
    <footer className="landing-footer">
      <div className="landing__container landing-footer__row">
        <span className="landing-nav__wordmark">prpreview</span>
        <ul className="landing-footer__links">
          <li>
            <a href={githubLoginUrl()}>GitHub</a>
          </li>
          <li>
            <span style={{ color: "var(--text-faint)", cursor: "default" }} title="Coming soon">
              Documentation
            </span>
          </li>
          <li>
            <a href="#security">Security</a>
          </li>
          <li>
            <span style={{ color: "var(--text-faint)", cursor: "default" }} title="Coming soon">
              Privacy
            </span>
          </li>
          <li>
            <span style={{ color: "var(--text-faint)", cursor: "default" }} title="Coming soon">
              Terms
            </span>
          </li>
        </ul>
        <span className="landing-footer__badge">Public Beta</span>
      </div>
    </footer>
  );
}
