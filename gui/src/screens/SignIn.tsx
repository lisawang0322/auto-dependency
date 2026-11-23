/** Live mode with sign-in: nothing else is shown until the person has signed in with the company identity provider. */
export function SignIn({ loginUrl, next, demo = false }: { loginUrl: string; next: string; /** AUTH=demo: the server's own sign-in page with people to sign in as. */ demo?: boolean }) {
  const go = () => { location.href = `${loginUrl}?next=${encodeURIComponent(next)}`; };
  return (
    <div>
      <header className="top">
        <div className="wrap top-row"><div className="brand"><span className="name">Throughline</span></div></div>
      </header>
      <main className="wrap page">
        <div className="stack" style={{ maxWidth: 520, marginTop: 24 }}>
          <div className="stack-sm">
            <span className="small muted">Sign in</span>
            <h1>Sign in with your company account</h1>
            <p className="lead">Your plans, runs and decisions are kept under your name. Jira and Devin connect through your company's accounts, never through a key you paste.</p>
          </div>
          <div>
            <button type="button" className="btn primary" style={{ padding: "0 20px" }} onClick={go}>Sign in</button>
          </div>
          <span className="small muted">{demo ? "Demo: you will be sent to a sign-in page that stands in for your company's, pick a person, and come back here." : "You will be sent to your company's sign-in page and back here."}</span>
        </div>
      </main>
    </div>
  );
}
