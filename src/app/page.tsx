import Link from "next/link";
import { controls } from "@/components/control-styles";
import { ArrowRight, BookOpen, FolderOpen, Users, Home, Coffee, Sun, Check } from "lucide-react";
import { Brand, Wordmark } from "@/components/brand";
import { GuestHome } from "@/features/identity/guest-home";
import { ThemeToggle } from "@/components/theme-toggle";

export default function HomePage() {
  return (
    <GuestHome>
      <header className="site-header flex justify-between items-center [max-width:1280px] [padding:26px_48px] m-auto [gap:24px] [&_nav]:flex [&_nav]:[gap:32px] [&_nav]:text-[var(--muted)] [&_nav]:text-xs max-[767px]:[padding:16px] max-[767px]:[gap:8px] max-[767px]:[&_nav]:hidden sticky top-0 z-20 bg-[var(--canvas)]">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#philosophy">Philosophy</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <div className="header-actions flex [gap:25px] items-center text-xs font-semibold max-[767px]:[gap:8px] max-[767px]:ml-auto max-[767px]:[flex-shrink:0] max-[767px]:[&_a]:whitespace-nowrap max-[767px]:[&_.button]:px-3">
          <ThemeToggle />
          <Link href="/sign-in" className="max-[767px]:hidden">
            Sign in
          </Link>
          <Link href="/sign-up" className={`${controls.primary} button !h-9 !min-h-9`}>
            Get started <ArrowRight size={15} className="max-[767px]:hidden" />
          </Link>
        </div>
      </header>
      <main id="main">
        <section className="hero text-center [padding:72px_24px_76px] [max-width:1220px] m-auto [&_>_.eyebrow]:[padding:6px_12px] [&_>_.eyebrow]:[border-radius:20px] [&_>_.eyebrow]:bg-[var(--sage)] [&_>_.eyebrow]:text-xs [&_h1]:[font-size:clamp(38px,_4.8vw,_64px)] [&_h1]:[font-weight:650] [&_h1]:[line-height:1.13] [&_h1]:[letter-spacing:-.055em] [&_h1]:[margin:24px_0_20px] [&_>_p]:[font-size:15px] [&_>_p]:[line-height:1.8] [&_>_.example-caption]:text-xs [&_>_.example-caption]:text-[var(--muted)] [&_>_.example-caption]:[margin-top:18px] max-[767px]:[padding:48px_20px] max-[767px]:[&_h1]:[font-size:32px] max-[767px]:[&_>_p]:text-xs">
          <div className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
            <span className="status-dot [display:inline-block] [height:6px] [width:6px] [background:var(--green)] rounded-full" />{" "}
            PRIVATE SPACES. SHARED CLARITY.
          </div>
          <h1>
            A little clarity for
            <br />
            everyday spending.
          </h1>
          <p>
            A shared space to record, understand, and plan spending,
            <br className="desktop-break max-[767px]:hidden" /> one bucket at a time.
          </p>
          <div className="hero-actions flex justify-center items-center [gap:28px] [margin-top:30px] max-[767px]:[gap:20px] max-[767px]:[&_>_.text-link]:text-xs max-[420px]:flex-col max-[420px]:[gap:18px]">
            <Link className={`${controls.primary} button !h-9 !min-h-9`} href="/sign-up">
              Get started <ArrowRight size={17} />
            </Link>
            <a
              className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px] max-[767px]:hidden"
              href="#how-it-works"
            >
              Learn how it works <ArrowRight size={16} />
            </a>
          </div>
          <p className="mt-4 text-xs text-[var(--muted)] min-[768px]:hidden">
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="font-semibold text-[var(--green)] underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
          <div
            className="bucket-showcase grid [grid-template-columns:repeat(3,_1fr)] [gap:22px] text-left [margin:70px_auto_14px] [max-width:980px] max-[767px]:[grid-template-columns:1fr] max-[767px]:[margin-top:45px] max-[767px]:[max-width:380px] max-[767px]:[gap:14px]"
            aria-label="Illustrative bucket examples"
          >
            <article className="sample-bucket [padding:26px] [border:1px_solid_var(--line)] [border-radius:13px] bg-[var(--surface)] [box-shadow:var(--shadow)] [&.featured]:bg-[var(--sage)] [&.featured]:[transform:translateY(-12px)] [&.featured]:[border-color:#cbdccf] [&_h2]:[font-size:17px] [&_h2]:[letter-spacing:-.03em] [&_h2]:[margin-bottom:3px] [&_p]:text-xs [&_strong]:[display:block] [&_strong]:[font-size:30px] [&_strong]:[letter-spacing:-.04em] [&_strong]:[font-weight:650] [&_strong]:[font-variant-numeric:tabular-nums] [&_strong]:[margin-top:20px] [&_strong_span]:[display:block] [&_strong_span]:text-xs [&_strong_span]:text-[var(--muted)] [&_strong_span]:[font-weight:400] [&_strong_span]:[letter-spacing:0] max-[767px]:[padding:23px] max-[767px]:[&.featured]:[transform:none] max-[767px]:[&_strong]:[margin-top:14px]">
              <div className="sample-top flex items-center justify-between [margin-bottom:21px] max-[767px]:[margin-bottom:15px]">
                <span className="tile-icon [width:38px] [height:38px] rounded-lg inline-flex items-center justify-center bg-[var(--soft)] text-[var(--green)]">
                  <Home size={21} />
                </span>
                <span className="avatar-pair flex [padding-left:5px] [&_i]:text-xs [&_i]:font-bold [&_i]:not-italic [&_i]:bg-[var(--sage)] [&_i]:grid [&_i]:[place-items:center] [&_i]:[width:24px] [&_i]:[height:24px] [&_i]:[border:2px_solid_var(--surface)] [&_i]:rounded-full [&_i]:[margin-left:-5px]">
                  <i>Y</i>
                  <i>P</i>
                </span>
              </div>
              <h2>House Expenses</h2>
              <p>Shared with Priya</p>
              <strong>
                ₹64,280<span>recorded this month</span>
              </strong>
              <div className="sample-tags flex [gap:6px] [margin-top:24px] flex-wrap [&_span]:[padding:3px_8px] [&_span]:bg-[var(--soft)] [&_span]:[border-radius:4px] [&_span]:text-xs [&_span]:text-[var(--muted)] max-[767px]:[margin-top:16px]">
                <span>Groceries</span>
                <span>Utilities</span>
                <span>Rent</span>
              </div>
            </article>
            <article className="sample-bucket [padding:26px] [border:1px_solid_var(--line)] [border-radius:13px] bg-[var(--surface)] [box-shadow:var(--shadow)] [&.featured]:bg-[var(--sage)] [&.featured]:[transform:translateY(-12px)] [&.featured]:[border-color:#cbdccf] [&_h2]:[font-size:17px] [&_h2]:[letter-spacing:-.03em] [&_h2]:[margin-bottom:3px] [&_p]:text-xs [&_strong]:[display:block] [&_strong]:[font-size:30px] [&_strong]:[letter-spacing:-.04em] [&_strong]:[font-weight:650] [&_strong]:[font-variant-numeric:tabular-nums] [&_strong]:[margin-top:20px] [&_strong_span]:[display:block] [&_strong_span]:text-xs [&_strong_span]:text-[var(--muted)] [&_strong_span]:[font-weight:400] [&_strong_span]:[letter-spacing:0] max-[767px]:[padding:23px] max-[767px]:[&.featured]:[transform:none] max-[767px]:[&_strong]:[margin-top:14px] featured [&_.sample-tags_span]:[background:#ffffff8c] [&_.tile-icon]:[background:#ffffff8c]">
              <div className="sample-top flex items-center justify-between [margin-bottom:21px] max-[767px]:[margin-bottom:15px]">
                <span className="tile-icon [width:38px] [height:38px] rounded-lg inline-flex items-center justify-center bg-[var(--soft)] text-[var(--green)]">
                  <Coffee size={21} />
                </span>
                <span className="pill text-xs font-semibold bg-[var(--soft)] text-[var(--muted)] [padding:3px_8px] [border-radius:5px] whitespace-nowrap">
                  Solo space
                </span>
              </div>
              <h2>Personal</h2>
              <p>A little space for yourself</p>
              <strong>
                ₹18,450<span>recorded this month</span>
              </strong>
              <div className="sample-tags flex [gap:6px] [margin-top:24px] flex-wrap [&_span]:[padding:3px_8px] [&_span]:bg-[var(--soft)] [&_span]:[border-radius:4px] [&_span]:text-xs [&_span]:text-[var(--muted)] max-[767px]:[margin-top:16px]">
                <span>Coffee</span>
                <span>Books</span>
                <span>Tech</span>
              </div>
            </article>
            <article className="sample-bucket [padding:26px] [border:1px_solid_var(--line)] [border-radius:13px] bg-[var(--surface)] [box-shadow:var(--shadow)] [&.featured]:bg-[var(--sage)] [&.featured]:[transform:translateY(-12px)] [&.featured]:[border-color:#cbdccf] [&_h2]:[font-size:17px] [&_h2]:[letter-spacing:-.03em] [&_h2]:[margin-bottom:3px] [&_p]:text-xs [&_strong]:[display:block] [&_strong]:[font-size:30px] [&_strong]:[letter-spacing:-.04em] [&_strong]:[font-weight:650] [&_strong]:[font-variant-numeric:tabular-nums] [&_strong]:[margin-top:20px] [&_strong_span]:[display:block] [&_strong_span]:text-xs [&_strong_span]:text-[var(--muted)] [&_strong_span]:[font-weight:400] [&_strong_span]:[letter-spacing:0] max-[767px]:[padding:23px] max-[767px]:[&.featured]:[transform:none] max-[767px]:[&_strong]:[margin-top:14px]">
              <div className="sample-top flex items-center justify-between [margin-bottom:21px] max-[767px]:[margin-bottom:15px]">
                <span className="tile-icon [width:38px] [height:38px] rounded-lg inline-flex items-center justify-center bg-[var(--soft)] text-[var(--green)]">
                  <Sun size={21} />
                </span>
                <span className="avatar-pair flex [padding-left:5px] [&_i]:text-xs [&_i]:font-bold [&_i]:not-italic [&_i]:bg-[var(--sage)] [&_i]:grid [&_i]:[place-items:center] [&_i]:[width:24px] [&_i]:[height:24px] [&_i]:[border:2px_solid_var(--surface)] [&_i]:rounded-full [&_i]:[margin-left:-5px]">
                  <i>M</i>
                  <i>A</i>
                  <i>+2</i>
                </span>
              </div>
              <h2>Summer Retreat</h2>
              <p>Group of 4</p>
              <strong>
                €2,410<span>recorded together</span>
              </strong>
              <div className="sample-tags flex [gap:6px] [margin-top:24px] flex-wrap [&_span]:[padding:3px_8px] [&_span]:bg-[var(--soft)] [&_span]:[border-radius:4px] [&_span]:text-xs [&_span]:text-[var(--muted)] max-[767px]:[margin-top:16px]">
                <span>Stay</span>
                <span>Travel</span>
                <span>Dining</span>
              </div>
            </article>
          </div>
          <p className="example-caption">Illustrative examples. Your buckets start fresh.</p>
        </section>
        <section
          id="philosophy"
          className="principles [border-top:1px_solid_var(--line)] text-center section-wrap [max-width:1100px] m-auto [padding:70px_40px] [&_h2]:[font-size:clamp(25px,_3vw,_35px)] [&_h2]:[margin-top:14px] [&_h2]:[font-weight:650] max-[767px]:[padding:48px_24px] max-[767px]:[&_h2]:[font-size:22px]"
        >
          <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
            FOUNDATIONAL PRINCIPLES
          </span>
          <h2>Finance without the sensory overload.</h2>
          <div className="three-columns grid [grid-template-columns:repeat(3,_1fr)] text-left [gap:44px] [margin-top:46px] [&_h3]:[margin:18px_0_12px] [&_p]:text-xs [&_p]:[line-height:1.9] max-[767px]:[grid-template-columns:1fr] max-[767px]:[gap:30px] max-[767px]:[margin-top:32px] max-[767px]:[&_article]:[max-width:440px] max-[767px]:[&_article]:m-auto">
            {[
              {
                icon: FolderOpen,
                title: "Your own spaces",
                copy: "Organize spending into independent buckets for yourself, your household, or your next adventure.",
              },
              {
                icon: Users,
                title: "Together when you choose",
                copy: "Invite a partner, roommate, or family member into a bucket. Keep the rest of your spending private.",
              },
              {
                icon: BookOpen,
                title: "A clearer everyday",
                copy: "Understand where your money goes, without complicated accounting or linking your bank.",
              },
            ].map(({ icon: Icon, title, copy }) => (
              <article key={title}>
                <span className="tile-icon [width:38px] [height:38px] rounded-lg inline-flex items-center justify-center bg-[var(--soft)] text-[var(--green)]">
                  <Icon size={23} />
                </span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>
        <section
          id="how-it-works"
          className="how-section grid [grid-template-columns:1.1fr_1fr] [gap:85px] items-center [padding-top:48px] [padding-bottom:85px] [&_p]:text-xs [&_p]:[line-height:1.9] [&_p]:[margin-top:20px] max-[767px]:[grid-template-columns:1fr] max-[767px]:[gap:32px] section-wrap [max-width:1100px] m-auto [padding:70px_40px] [&_h2]:[font-size:clamp(25px,_3vw,_35px)] [&_h2]:[margin-top:14px] [&_h2]:[font-weight:650] max-[767px]:[padding:48px_24px] max-[767px]:[&_h2]:[font-size:22px]"
        >
          <div>
            <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
              DELIBERATE SIMPLICITY
            </span>
            <h2>
              Designed for natural
              <br />
              human collaboration.
            </h2>
            <p>
              Start with one bucket. Give it a name, choose your currency, and invite your people
              when you’re ready.
            </p>
            <ul className="check-list [padding:0] [list-style:none] grid [gap:12px] text-xs [margin-top:26px] text-[var(--muted)] [&_li]:flex [&_li]:items-center [&_li]:[gap:9px] [&_svg]:text-[var(--green)]">
              <li>
                <Check size={17} /> Keep personal and shared spending separate
              </li>
              <li>
                <Check size={17} /> Choose who has access to each bucket
              </li>
              <li>
                <Check size={17} /> Build a little more clarity, day by day
              </li>
            </ul>
          </div>
          <div className="ledger-example [padding:24px] bg-[var(--surface)] [border:1px_solid_var(--line)] [border-radius:12px] [box-shadow:var(--shadow)] [transform:rotate(-2deg)] max-[767px]:[transform:none]">
            <div className="ledger-heading flex justify-between [padding-bottom:20px] text-xs [font-weight:650]">
              <span>Monthly ledger</span>
              <span className="pill text-xs font-semibold bg-[var(--soft)] text-[var(--muted)] [padding:3px_8px] [border-radius:5px] whitespace-nowrap">
                Example
              </span>
            </div>
            {[
              ["Farmers Market", "Groceries", "₹1,840"],
              ["Bookshop", "Personal", "₹680"],
              ["Kitchen Provisions", "Household", "₹3,200"],
            ].map(([name, category, amount]) => (
              <div
                className="ledger-row flex [gap:13px] items-center [padding:17px_0] [border-top:1px_solid_var(--line)] [&_b]:text-xs [&_small]:[display:block] [&_small]:text-xs [&_small]:text-[var(--muted)] [&_strong]:ml-auto [&_strong]:text-xs"
                key={name}
              >
                <span className="tile-icon [width:38px] [height:38px] rounded-lg inline-flex items-center justify-center bg-[var(--soft)] text-[var(--green)]">
                  <FolderOpen size={18} />
                </span>
                <div>
                  <b>{name}</b>
                  <small>{category}</small>
                </div>
                <strong>{amount}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="cta-section [&_h2]:[font-size:clamp(25px,_3vw,_35px)] [&_h2]:[margin-top:14px] [&_h2]:[font-weight:650] text-center [padding:70px_24px_78px] bg-[var(--sage)] [&_p]:[margin:18px_0_26px] [&_p]:text-xs max-[767px]:[&_h2]:[font-size:22px]">
          <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
            A FRESH START
          </span>
          <h2>Ready for calm everyday spending?</h2>
          <p>
            Start small with a single bucket. Share it if you choose,
            <br className="desktop-break max-[767px]:hidden" /> or keep it quiet for yourself.
          </p>
          <Link className={`${controls.primary} button !h-9 !min-h-9`} href="/sign-up">
            Create your first bucket <ArrowRight size={16} />
          </Link>
        </section>
      </main>
      <footer className="site-footer [max-width:1280px] m-auto flex items-center justify-between [padding:32px_48px] text-[var(--muted)] text-xs [&_.wordmark]:[font-size:23px] max-[767px]:[padding:28px_24px] max-[767px]:[&_>_span:nth-child(2)]:hidden">
        <Wordmark />
        <span>Made for everyday life.</span>
        <span>© {new Date().getFullYear()} Buckit</span>
      </footer>
    </GuestHome>
  );
}
