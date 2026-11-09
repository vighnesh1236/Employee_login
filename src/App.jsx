import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowRight, Bell, BriefcaseBusiness, CalendarDays,
  Check, CheckCheck, ChevronDown, CircleDollarSign, Clock3, FileText, LayoutDashboard, MessageCircle,
  LogOut, Menu, Moon, Plus, RotateCw, Search, Settings2, ShieldCheck, Sparkles, Sun,
  TrendingUp, Upload, Users, UserRound, X
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";

const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "employees", label: "People", icon: Users, admin: true },
  { id: "attendance", label: "Attendance", icon: Clock3 },
  { id: "holidays", label: "Holiday calendar", icon: CalendarDays },
  { id: "leaves", label: "Time off", icon: CalendarDays },
  { id: "messages", label: "Messages", icon: MessageCircle },
  { id: "payroll", label: "Payroll", icon: CircleDollarSign },
  { id: "performance", label: "Performance", icon: TrendingUp },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "notifications", label: "Inbox", icon: Bell },
  { id: "profile", label: "Profile", icon: UserRound }
];

const money = (value) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 0
}).format(Number(value || 0));
const dateLabel = (value) => value ? new Date(value).toLocaleDateString("en-IN", {
  day: "numeric", month: "short", year: "numeric"
}) : "—";
const roleLabel = (role) => ({
  super_admin: "Super admin", hr: "Human resources", manager: "Manager",
  employee: "Employee", intern: "Intern"
}[role] || role);

function UserAvatar({ src, name, className = "" }) {
  const initials = (name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <div className={`avatar ${className}`}>{src ? <img src={src} alt="" /> : initials}</div>;
}

async function request(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    }
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}

function ImageCaptcha({ challenge, answer, loading, onAnswerChange, onRefresh }) {
  return (
    <div className="image-captcha">
      <div className="captcha-image-row">
        {challenge
          ? <img className="captcha-image" src={challenge.image} alt="CAPTCHA characters. Type the letters and numbers shown." />
          : <div className="captcha-image captcha-image-loading">{loading ? "Loading CAPTCHA…" : "CAPTCHA unavailable"}</div>}
        <button className="captcha-refresh" type="button" onClick={onRefresh} disabled={loading} aria-label="Get a new CAPTCHA" title="Get a new CAPTCHA"><RotateCw size={17} /></button>
      </div>
      <label htmlFor="captcha-answer">Type the characters shown
        <input id="captcha-answer" name="captchaAnswer" type="text" required autoComplete="off" autoCapitalize="characters" spellCheck="false" maxLength={6} value={answer} onChange={(event) => onAnswerChange(event.target.value)} />
      </label>
    </div>
  );
}

function AuthScreen({ setupRequired, adminEmail, onSuccess }) {
  const [mode, setMode] = useState(setupRequired ? "setup" : "login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [captcha, setCaptcha] = useState(null);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(true);
  const [profilePicture, setProfilePicture] = useState(null);
  const [profilePreview, setProfilePreview] = useState("");
  const [form, setForm] = useState({
    fullName: "", email: setupRequired ? adminEmail : "", password: "",
    confirmPassword: "", phone: "", department: "Engineering", designation: "",
    employmentType: "Full-Time Employee", joiningDate: "", address: "", emergencyContact: ""
  });
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  useEffect(() => {
    if (!profilePicture) {
      setProfilePreview("");
      return undefined;
    }
    const previewUrl = URL.createObjectURL(profilePicture);
    setProfilePreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [profilePicture]);
  const refreshCaptcha = useCallback(async () => {
    setCaptcha(null);
    setCaptchaAnswer("");
    setCaptchaLoading(true);
    try {
      setCaptcha(await request("/api/auth/captcha"));
    } catch (reason) {
      setError(`Unable to load CAPTCHA: ${reason.message}`);
    } finally {
      setCaptchaLoading(false);
    }
  }, []);
  useEffect(() => { void refreshCaptcha(); }, [refreshCaptcha]);
  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if ((mode === "setup" || mode === "register") && form.password !== form.confirmPassword) {
      setError("Your passwords do not match.");
      return;
    }
    if (!captcha?.challengeId || !captchaAnswer.trim()) {
      setError("Enter the CAPTCHA characters to continue.");
      return;
    }
    setBusy(true);
    let authenticated = false;
    try {
      const route = mode === "setup" ? "/api/auth/setup" : mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const captchaFields = { captchaChallengeId: captcha.challengeId, captchaAnswer };
      let payload;
      if (mode === "register") {
        payload = new FormData();
        Object.entries({ ...form, ...captchaFields }).forEach(([key, value]) => payload.append(key, value));
        if (profilePicture) payload.append("profilePicture", profilePicture);
      } else {
        payload = mode === "setup"
          ? { fullName: form.fullName, email: form.email, password: form.password, ...captchaFields }
          : { email: form.email, password: form.password, ...captchaFields };
      }
      const result = await request(route, { method: "POST", body: payload instanceof FormData ? payload : JSON.stringify(payload) });
      if (mode === "register") {
        setNotice(result.message);
        setMode("login");
        setProfilePicture(null);
        setForm((current) => ({ ...current, password: "", confirmPassword: "" }));
      } else {
        authenticated = true;
        onSuccess(result.user);
      }
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
      if (!authenticated) void refreshCaptcha();
    }
  };
  const setup = mode === "setup";
  const register = mode === "register";

  return (
    <main className="auth-page">
      <div className="auth-art">
        <div className="auth-art-top"><span className="brand-mark"><Sparkles size={18} /></span><span>V_SOLUTIONS</span></div>
        <div className="auth-art-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> PEOPLE, IN SYNC</div>
          <h1>Better work<br />starts <em>together.</em></h1>
          <p>One thoughtful space to support your people and move your work forward.</p>
        </div>
        <div className="auth-art-card">
          <div className="orbit-graphic"><span /><i /><b /></div>
          <div><small>YOUR PEOPLE, AT A GLANCE</small><strong>A calmer way to work.</strong></div>
          <ArrowRight size={18} />
        </div>
        <span className="art-glow glow-one" /><span className="art-glow glow-two" />
      </div>
      <section className="auth-panel">
        <div className="auth-mobile-brand"><span className="brand-mark"><Sparkles size={18} /></span> V_SOLUTIONS</div>
        <div className="auth-box">
          <div className="auth-heading">
            <span className="section-kicker">{setup ? "FIRST-TIME SETUP" : register ? "JOIN YOUR TEAM" : "WELCOME BACK"}</span>
            <h2>{setup ? "Create your admin account" : register ? "Create your profile" : "Sign in to your space"}</h2>
            <p>{setup ? "Set a password for the super administrator account." : register ? "Your details will be shared with your administrator for approval." : "Your people, your workday, all in one place."}</p>
          </div>
          <form onSubmit={handleSubmit} className="auth-form">
            {(setup || register) && <label>Full name<input required minLength="2" autoComplete="name" value={form.fullName} onChange={set("fullName")} placeholder="Your name" /></label>}
            <label>Email address<input required type="email" autoComplete="email" value={form.email} onChange={set("email")} placeholder="you@company.com" readOnly={setup} /></label>
            {register && (
              <>
                <div className="form-grid">
                  <label>Phone<input value={form.phone} onChange={set("phone")} placeholder="+91 98765 43210" /></label>
                  <label>Role<select value={form.employmentType} onChange={set("employmentType")}><option value="Full-Time Employee">Employee</option><option value="Intern">Intern</option><option value="HR">HR</option><option value="Manager">Manager</option></select></label>
                  <label>Department<input required value={form.department} onChange={set("department")} /></label>
                  <label>Designation<input required value={form.designation} onChange={set("designation")} placeholder="e.g. Product Designer" /></label>
                  <label>Joining date<input type="date" value={form.joiningDate} onChange={set("joiningDate")} /></label>
                  <label>Emergency contact<input value={form.emergencyContact} onChange={set("emergencyContact")} /></label>
                </div>
                <label>Address<input value={form.address} onChange={set("address")} /></label>
                <div className="profile-picture-field">
                  <div className="avatar profile-picture-preview">{profilePreview ? <img src={profilePreview} alt="Selected profile picture preview" /> : <UserRound size={20} />}</div>
                  <label>Profile picture (optional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setProfilePicture(event.target.files?.[0] || null)} /><small>JPG, PNG, or WebP · up to 5 MB</small></label>
                </div>
              </>
            )}
            <label>{setup || register ? "Create password" : "Password"}
              <input required type="password" minLength={setup ? 12 : register ? 10 : 1} autoComplete={setup || register ? "new-password" : "current-password"} value={form.password} onChange={set("password")} placeholder={setup ? "At least 12 characters" : "Enter your password"} />
            </label>
            {(setup || register) && <label>Confirm password<input required type="password" minLength={setup ? 12 : 10} autoComplete="new-password" value={form.confirmPassword} onChange={set("confirmPassword")} placeholder="Enter your password again" /></label>}
            <ImageCaptcha challenge={captcha} answer={captchaAnswer} loading={captchaLoading} onAnswerChange={(value) => { setCaptchaAnswer(value); setError(""); }} onRefresh={() => { setError(""); void refreshCaptcha(); }} />
            {error && <div className="form-alert error-alert" role="alert">{error}</div>}
            {notice && <div className="form-alert success-alert" role="status">{notice}</div>}
            <button className="button button-primary auth-submit" disabled={busy || captchaLoading || !captcha?.challengeId || !captchaAnswer.trim()}>{busy ? <span className="spinner" /> : setup ? "Create administrator account" : register ? "Submit for approval" : "Sign in"} <ArrowRight size={17} /></button>
          </form>
          {!setup && (
            <p className="auth-switch">
              {register ? "Already have an account?" : "New to your team?"}
              <button onClick={() => { setError(""); setNotice(""); setProfilePicture(null); setMode(register ? "login" : "register"); void refreshCaptcha(); }}> {register ? "Sign in" : "Request access"}</button>
            </p>
          )}
          {setup && <p className="setup-note"><ShieldCheck size={15} /> Only the configured administrator email can initialize this workspace.</p>}
        </div>
        <div className="auth-footer"><span>© {new Date().getFullYear()} V_Solutions</span><span>Secure employee workspace</span></div>
      </section>
    </main>
  );
}

function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("overview");
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState("");
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [attendanceMonth, setAttendanceMonth] = useState(new Date().toISOString().slice(0, 7));
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());
  const [selectedChatUserId, setSelectedChatUserId] = useState("");
  const isAdmin = user && ["super_admin", "hr"].includes(user.role);
  const canReview = user && ["super_admin", "hr"].includes(user.role);

  const flash = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3800);
  }, []);

  const loadPage = useCallback(async (selected = page, currentUser = user) => {
    if (!currentUser) return;
    setPageLoading(true);
    try {
      if (selected === "overview") {
        const overview = await request("/api/dashboard");
        setData((current) => ({ ...current, overview }));
      }
      if (selected === "employees") {
        const [result, overview] = await Promise.all([request("/api/employees"), request("/api/dashboard")]);
        setData((current) => ({ ...current, employees: result.employees, overview }));
      }
      if (selected === "attendance") {
        const [result, employees] = await Promise.all([
          request(`/api/attendance?month=${attendanceMonth}`),
          currentUser.role === "super_admin" ? request("/api/employees") : Promise.resolve({ employees: [] })
        ]);
        setData((current) => ({ ...current, attendance: result.attendance, employees: employees.employees }));
      }
      if (selected === "holidays") {
        const result = await request(`/api/holidays?year=${calendarYear}`);
        setData((current) => ({ ...current, holidays: result.holidays }));
      }
      if (selected === "leaves") {
        const result = await request("/api/leaves");
        setData((current) => ({ ...current, leaves: result.requests, balances: result.balances }));
      }
      if (selected === "messages") {
        const result = await request("/api/messages");
        const employeeId = selectedChatUserId || result.conversations[0]?.employee_id;
        const thread = employeeId ? await request(`/api/messages/${employeeId}`) : { messages: [] };
        setSelectedChatUserId(employeeId || "");
        setData((current) => ({ ...current, conversations: result.conversations, messages: thread.messages }));
      }
      if (selected === "payroll") {
        const result = await request("/api/payroll");
        setData((current) => ({ ...current, payroll: result.records, monthlySalary: result.monthlySalary }));
      }
      if (selected === "performance") {
        const result = await request(`/api/performance${currentUser.role === "super_admin" ? "?all=true" : ""}`);
        const employees = ["super_admin", "manager"].includes(currentUser.role) ? await request("/api/employees") : { employees: [] };
        setData((current) => ({ ...current, reviews: result.reviews, employees: employees.employees }));
      }
      if (selected === "documents") {
        const [result, dropbox] = await Promise.all([request("/api/documents"), request("/api/dropbox/status")]);
        setData((current) => ({ ...current, documents: result.documents, dropbox }));
      }
      if (selected === "notifications") {
        const result = await request("/api/notifications");
        setData((current) => ({ ...current, notifications: result.notifications }));
      }
    } catch (error) {
      flash(error.message);
    } finally {
      setPageLoading(false);
    }
  }, [page, user, flash, attendanceMonth, calendarYear, selectedChatUserId]);

  useEffect(() => {
    let active = true;
    const dropboxResult = new URLSearchParams(window.location.search).get("dropbox");
    if (dropboxResult) {
      setToast(dropboxResult === "connected" ? "Dropbox account connected." : dropboxResult === "denied" ? "Dropbox connection was cancelled." : "Dropbox could not be connected. Try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    request("/api/bootstrap").then(async (setup) => {
      const session = setup.setupRequired ? null : await request("/api/me").catch(() => null);
      if (!active) return;
      setBootstrap(setup);
      if (session?.user) setUser(session.user);
      setLoading(false);
    }).catch((error) => {
      if (!active) return;
      setToast(error.message);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => { if (user) loadPage(page, user); }, [page, user, loadPage]);

  const changePage = (next) => {
    setPage(next);
    setMobileOpen(false);
    setSearch("");
  };
  const logout = async () => {
    try { await request("/api/auth/logout", { method: "POST" }); } catch { /* Local session is still cleared. */ }
    setUser(null);
    setData({});
    setSelectedChatUserId("");
    setPage("overview");
  };
  const action = async (path, method, body, message, reload = page) => {
    setBusy(true);
    try {
      await request(path, { method, body: body instanceof FormData ? body : JSON.stringify(body) });
      setModal("");
      setForm({});
      flash(message);
      await loadPage(reload, user);
      if (reload !== "overview") await loadPage("overview", user);
    } catch (error) {
      flash(error.message);
    } finally {
      setBusy(false);
    }
  };
  const visibleNavigation = useMemo(() => navigation.filter((item) => {
    if (item.admin && !isAdmin) return false;
    if (item.id === "employees" && !["super_admin", "hr", "manager"].includes(user?.role)) return false;
    if (item.id === "payroll" && !["super_admin", "hr", "manager", "employee", "intern"].includes(user?.role)) return false;
    return true;
  }), [isAdmin, user]);

  if (loading) return <div className="loading-screen"><div className="loading-orbit"><Sparkles size={22} /></div><span>Getting your workspace ready</span></div>;
  if (bootstrap?.setupRequired || !user) return <AuthScreen setupRequired={bootstrap?.setupRequired} adminEmail={bootstrap?.adminEmail} captchaEnabled={bootstrap?.captchaEnabled} captchaRequired={bootstrap?.captchaRequired} onSuccess={(nextUser) => {
    setUser(nextUser);
    setBootstrap((current) => ({ ...current, setupRequired: false }));
  }} />;

  const currentPage = navigation.find((item) => item.id === page)?.label || "Overview";
  const userInitials = (user.fullName || user.email).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

  return (
    <div className={`app-shell${dark ? " dark-mode" : ""}`}>
      <aside className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark"><Sparkles size={18} /></span><span>V_<span className="brand-light">Solutions</span></span><button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={19} /></button></div>
        <div className="workspace-switch"><div className="workspace-icon">V</div><div><strong>V_Solutions</strong><small>People workspace</small></div><ChevronDown size={15} /></div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="side-nav">
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-item${page === item.id ? " active" : ""}`} onClick={() => changePage(item.id)}><Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.id === "notifications" && <i className="nav-dot" />}</button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="upgrade-card"><span className="upgrade-icon"><Sparkles size={16} /></span><strong>People, in sync.</strong><p>A little more clarity makes a big difference.</p><div className="upgrade-progress"><i /></div><small>Workspace overview <b>4 of 8 modules</b></small></div>
          <div className="security-caption"><ShieldCheck size={15} />Secure team workspace</div>
          <div className="sidebar-user"><UserAvatar src={user.profilePicture} name={user.fullName} className="avatar-small" /><div className="sidebar-user-text"><strong>{user.fullName}</strong><small>{roleLabel(user.role)}</small></div><button aria-label="Sign out" onClick={logout}><LogOut size={17} /></button></div>
        </div>
      </aside>
      {mobileOpen && <button className="mobile-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={21} /></button>
          <div className="breadcrumbs">Workspace <span>/</span> <strong>{currentPage}</strong></div>
          <div className="topbar-actions">
            <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search anything..." /><kbd>⌘ K</kbd></label>
            <button className="icon-button theme-toggle" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button className="icon-button notification-button" onClick={() => changePage("notifications")} aria-label="Open notifications"><Bell size={18} /><i /></button>
            <button className="avatar avatar-small top-avatar" onClick={() => changePage("profile")} aria-label="Open profile">{user.profilePicture ? <img src={user.profilePicture} alt="" /> : userInitials}</button>
          </div>
        </header>
        <section className="page-content">
          {pageLoading && <div className="loading-line" />}
          {page === "overview" && <Overview user={user} data={data.overview} onNavigate={changePage} onRefresh={() => loadPage("overview", user)} />}
          {page === "employees" && <Employees data={data} search={search} user={user} onAction={action} onEditSalary={(employee) => { setForm({ employeeId: employee.id, fullName: employee.full_name, monthlySalary: Number(employee.monthly_salary) }); setModal("employeeSalary"); }} onRefresh={() => loadPage("employees", user)} />}
          {page === "attendance" && <Attendance user={user} rows={data.attendance || []} employees={data.employees || []} month={attendanceMonth} onMonthChange={setAttendanceMonth} onAction={action} onRefresh={() => loadPage("attendance", user)} />}
          {page === "holidays" && <HolidayCalendar year={calendarYear} holidays={data.holidays || []} onYearChange={setCalendarYear} />}
          {page === "leaves" && <Leaves user={user} rows={data.leaves || []} balances={data.balances || []} onOpen={() => { setForm({}); setModal("leave"); }} onReview={(id, status) => action(`/api/leaves/${id}/status`, "PATCH", { status }, `Leave request ${status}.`)} />}
          {page === "messages" && <Messages user={user} conversations={data.conversations || []} selectedEmployeeId={selectedChatUserId} messages={data.messages || []} onSelect={setSelectedChatUserId} onSend={(message) => action("/api/messages", "POST", { employeeId: selectedChatUserId, message }, "Message sent.", "messages")} onRequestLeave={() => { setForm({ leaveType: "medical" }); setModal("leave"); }} onReviewLeave={(id, status) => action(`/api/leaves/${id}/status`, "PATCH", { status }, `Leave request ${status}.`, "messages")} />}
          {page === "payroll" && <Payroll user={user} rows={data.payroll || []} monthlySalary={data.monthlySalary} onOpen={() => { setForm({ payMonth: new Date().toISOString().slice(0, 7), bonus: 0, deductions: 0 }); setModal("payroll"); }} onEdit={(row) => { setForm({ id: row.id, fullName: row.full_name, baseSalary: Number(row.base_salary), bonus: Number(row.bonus), deductions: Number(row.deductions) }); setModal("salaryRecord"); }} onPay={(id, status) => action(`/api/payroll/${id}/status`, "PATCH", { status }, `Salary marked ${status}.`)} />}
          {page === "performance" && <Performance user={user} rows={data.reviews || []} employees={data.employees || []} onOpen={() => { setForm({ reviewMonth: new Date().toISOString().slice(0, 7), taskCompletion: 80, productivity: 80, quality: 80, attendance: 80, teamwork: 80, communication: 80 }); setModal("performance"); }} />}
          {page === "documents" && <Documents rows={data.documents || []} dropbox={data.dropbox} onUpload={(formData) => action("/api/documents", "POST", formData, "Document uploaded.", "documents")} onDelete={(id) => action(`/api/documents/${id}`, "DELETE", null, "Document removed.", "documents")} />}
          {page === "notifications" && <Notifications rows={data.notifications || []} />}
          {page === "profile" && <Profile user={user} dark={dark} onToggleTheme={() => setDark((value) => !value)} onLogout={logout} onSaveUpi={async (upiId) => {
            const result = await request("/api/me/payment-details", { method: "PATCH", body: JSON.stringify({ upiId }) });
            setUser(result.user);
            flash("UPI details saved.");
          }} onUploadPicture={async (file) => {
            const formData = new FormData();
            formData.append("profilePicture", file);
            const result = await request("/api/me/profile-picture", { method: "POST", body: formData });
            setUser(result.user);
            flash("Profile photo updated.");
          }} />}
        </section>
      </main>
      {modal && <Modal type={modal} form={form} setForm={setForm} busy={busy} employees={data.employees || []} user={user} onClose={() => setModal("")} onSubmit={(event) => {
        event.preventDefault();
        if (modal === "leave") action("/api/leaves", "POST", form, "Leave request submitted.", page === "messages" ? "messages" : "leaves");
        if (modal === "payroll") action("/api/payroll/generate", "POST", { ...form, bonus: Number(form.bonus), deductions: Number(form.deductions) }, "Payroll generated for review.", "payroll");
        if (modal === "employeeSalary") action(`/api/employees/${form.employeeId}/salary`, "PATCH", { monthlySalary: Number(form.monthlySalary) }, "Monthly base salary updated.", "employees");
        if (modal === "salaryRecord") action(`/api/payroll/${form.id}`, "PATCH", { baseSalary: Number(form.baseSalary), bonus: Number(form.bonus), deductions: Number(form.deductions) }, "Salary record updated.", "payroll");
        if (modal === "performance") action("/api/performance", "POST", {
          ...form,
          taskCompletion: Number(form.taskCompletion), productivity: Number(form.productivity),
          quality: Number(form.quality), attendance: Number(form.attendance),
          teamwork: Number(form.teamwork), communication: Number(form.communication)
        }, "Performance review published.", "performance");
      }} />}
      {toast && <div className="toast"><CheckCheck size={17} />{toast}<button onClick={() => setToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
    </div>
  );
}

function PageHeading({ eyebrow, title, subtitle, action, buttonText, icon: Icon = Plus }) {
  return <div className="page-heading"><div><div className="section-kicker">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{buttonText && <button className="button button-primary" onClick={action}><Icon size={17} />{buttonText}</button>}</div>;
}

function Profile({ user, dark, onToggleTheme, onLogout, onSaveUpi, onUploadPicture }) {
  const [selectedPicture, setSelectedPicture] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const [pictureError, setPictureError] = useState("");
  const [upiId, setUpiId] = useState(user.upiId || "");
  const [savingUpi, setSavingUpi] = useState(false);
  const [upiError, setUpiError] = useState("");
  const pictureInput = useRef(null);
  useEffect(() => setUpiId(user.upiId || ""), [user.upiId]);
  const details = [
    ["Full name", user.fullName],
    ["Email address", user.email],
    ["Employee ID", user.employeeCode || "Not assigned"],
    ["Role", roleLabel(user.role)],
    ["Designation", user.designation || "Not set"],
    ["Department", user.department || "Not assigned"],
    ["Joining date", dateLabel(user.joiningDate)],
    ["Account status", user.status]
  ];

  useEffect(() => {
    if (!selectedPicture) {
      setPreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(selectedPicture);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedPicture]);

  const choosePicture = (event) => {
    const file = event.target.files?.[0] || null;
    setPictureError("");
    if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setPictureError("Choose a JPG, PNG, or WebP image.");
      event.target.value = "";
      return;
    }
    if (file && file.size > 5 * 1024 * 1024) {
      setPictureError("Profile pictures must be 5 MB or smaller.");
      event.target.value = "";
      return;
    }
    setSelectedPicture(file);
  };

  const savePicture = async () => {
    if (!selectedPicture) return;
    setUploadingPicture(true);
    setPictureError("");
    try {
      await onUploadPicture(selectedPicture);
      setSelectedPicture(null);
      if (pictureInput.current) pictureInput.current.value = "";
    } catch (error) {
      setPictureError(error.message);
    } finally {
      setUploadingPicture(false);
    }
  };
  const saveUpi = async (event) => {
    event.preventDefault();
    setSavingUpi(true);
    setUpiError("");
    try {
      await onSaveUpi(upiId.trim());
    } catch (error) {
      setUpiError(error.message);
    } finally {
      setSavingUpi(false);
    }
  };

  return <>
    <PageHeading eyebrow="YOUR ACCOUNT" title="Profile" subtitle="Your account details and personal workspace preferences." />
    <div className="profile-layout">
      <section className="panel profile-card">
        <div className="profile-identity">
          <UserAvatar src={previewUrl || user.profilePicture} name={user.fullName} className="profile-avatar" />
          <div className="profile-identity-copy"><h2>{user.fullName}</h2><p>{user.designation || roleLabel(user.role)}</p>
            <div className="profile-photo-actions">
              <input ref={pictureInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePicture} />
              <button className="button button-secondary button-small" type="button" onClick={() => pictureInput.current?.click()} disabled={uploadingPicture}>
                <Upload size={14} />{user.profilePicture ? "Change photo" : "Add profile photo"}
              </button>
              {selectedPicture && <button className="button button-primary button-small" type="button" onClick={savePicture} disabled={uploadingPicture}>
                {uploadingPicture ? <span className="spinner" /> : <Check size={14} />}{uploadingPicture ? "Uploading…" : "Save photo"}
              </button>}
            </div>
            {pictureError && <p className="profile-photo-error" role="alert">{pictureError}</p>}
            <small className="profile-photo-hint">Optional · JPG, PNG, or WebP · up to 5 MB</small>
          </div>
        </div>
        <div className="profile-details">
          {details.map(([label, value]) => <div className="profile-field" key={label}><span>{label}</span><strong>{value || "—"}</strong></div>)}
        </div>
      </section>
      <section className="panel profile-settings">
        <form className="profile-setting upi-setting" onSubmit={saveUpi}>
          <div><h3>UPI payment details</h3><p>Your UPI ID is visible only to you and the super admin in payroll review.</p></div>
          <div className="upi-form-row"><input type="text" maxLength="100" autoComplete="off" value={upiId} onChange={(event) => setUpiId(event.target.value)} placeholder="name@bank" aria-label="UPI ID" /><button className="button button-secondary" disabled={savingUpi}>{savingUpi ? <span className="spinner" /> : <Check size={16} />}Save UPI ID</button></div>
          {upiError && <p className="profile-photo-error" role="alert">{upiError}</p>}
        </form>
        <div className="profile-setting">
          <div><h3>Appearance</h3><p>Choose the theme for your workspace.</p></div>
          <button className="button button-secondary" onClick={onToggleTheme}>{dark ? <Sun size={16} /> : <Moon size={16} />}{dark ? "Switch to light mode" : "Switch to dark mode"}</button>
        </div>
        <div className="profile-setting profile-logout-setting">
          <div><h3>Sign out</h3><p>End your current session on this device.</p></div>
          <button className="button button-secondary" onClick={onLogout}><LogOut size={16} />Log out</button>
        </div>
      </section>
    </div>
  </>;
}

function Overview({ user, data, onNavigate }) {
  const admin = ["super_admin", "hr"].includes(user.role);
  if (!data) return <div className="empty-panel">Loading your workspace data…</div>;
  const adminStats = [
    { title: "Team members", value: data.stats?.employees || 0, note: `${data.stats?.interns || 0} interns`, icon: Users, tone: "violet" },
    { title: "Pending requests", value: data.stats?.pending || 0, note: "Awaiting review", icon: Clock3, tone: "amber" },
    { title: "Attendance this month", value: data.stats?.attendance || 0, note: `${data.stats?.attendanceToday || 0} today`, icon: Activity, tone: "blue" },
    { title: "Monthly payroll", value: money(data.stats?.monthlyPayroll), note: "Current month", icon: CircleDollarSign, tone: "green" }
  ];
  const employeeStats = [
    { title: "Present this month", value: data.stats?.present || 0, note: "Attendance days", icon: CalendarDays, tone: "violet" },
    { title: "Medical leave", value: data.balances?.find((item) => item.leave_type === "medical")?.remaining ?? 2, note: "Days remaining", icon: Activity, tone: "blue" },
    { title: "Casual leave", value: data.balances?.find((item) => item.leave_type === "casual")?.remaining ?? 1, note: "Days remaining", icon: CalendarDays, tone: "amber" },
    { title: "Performance score", value: data.performance?.overall_score ? `${Math.round(data.performance.overall_score)}%` : "—", note: "Latest monthly review", icon: TrendingUp, tone: "green" }
  ];
  const statCards = admin ? adminStats : employeeStats;
  const now = new Date();
  return (
    <>
      <div className="welcome-strip">
        <div className="welcome-copy"><div className="section-kicker">YOUR WORKSPACE · {now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }).toUpperCase()}</div><h1>{admin ? "Good to see you" : `Hello, ${user.fullName.split(" ")[0]}`}<span className="wave">✦</span></h1><p>{admin ? "Here’s what’s happening with your people today." : `${user.designation || roleLabel(user.role)} · ${user.department || "Your team"} · ${user.employeeCode || "Employee profile"}`}</p></div>
        <div className="welcome-visual"><div className="sun-disc" /><span className="welcome-orbit o1" /><span className="welcome-orbit o2" /><span className="welcome-star s1">✦</span><span className="welcome-star s2">✧</span><div className="welcome-pill"><span /> All systems in sync</div></div>
      </div>
      <div className="stats-grid">
        {statCards.map((item) => { const Icon = item.icon; return <div className="stat-card" key={item.title}><div className={`stat-icon ${item.tone}`}><Icon size={19} /></div><div className="stat-title">{item.title}</div><div className="stat-value">{item.value}</div><div className="stat-note"><span className="stat-note-dot" />{item.note}</div></div>; })}
      </div>
      <div className="dashboard-grid">
        <section className="panel trend-panel">
          <div className="panel-heading"><div><h3>{admin ? "Team attendance" : "Your attendance"}</h3><p>Monthly activity overview</p></div><button className="text-button" onClick={() => onNavigate("attendance")}>View attendance <ArrowRight size={15} /></button></div>
          <div className="chart-wrap">
            {admin && data.attendanceTrend?.length
              ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={data.attendanceTrend} margin={{ top: 10, right: 12, left: -20, bottom: 0 }}><defs><linearGradient id="attendanceFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#7764e8" stopOpacity={0.22} /><stop offset="95%" stopColor="#7764e8" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#eef0f5" /><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#9298a8", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "#9298a8", fontSize: 11 }} /><Tooltip contentStyle={{ border: "1px solid #eceef4", borderRadius: 12, boxShadow: "0 8px 30px #18204412" }} /><Area type="monotone" dataKey="days" stroke="#7665dc" strokeWidth={2.5} fill="url(#attendanceFill)" /></AreaChart></ResponsiveContainer>
              : <div className="chart-empty"><div className="chart-empty-icon"><Activity size={21} /></div><strong>No attendance trend yet</strong><span>Attendance activity will appear here as the super admin records it.</span></div>}
          </div>
          <div className="chart-legend"><span><i className="legend-purple" /> Attendance records</span><small>Live from your database</small></div>
        </section>
        <section className="panel quick-panel">
          <div className="panel-heading"><div><h3>{admin ? "Needs your attention" : "Your latest updates"}</h3><p>{admin ? "Keep your workspace moving" : "Everything important, in one place"}</p></div><span className="panel-count">{(admin ? data.pending?.length : data.notifications?.length) || 0}</span></div>
          <div className="attention-list">
            {admin && data.pending?.length ? data.pending.slice(0, 4).map((item) => <div className="attention-item" key={item.id}><div className="attention-avatar">{(item.full_name || item.email)[0].toUpperCase()}</div><div className="attention-text"><strong>{item.full_name || item.email}</strong><span>{item.designation || roleLabel(item.role)} · New registration</span></div><button aria-label={`Review ${item.full_name}`} onClick={() => onNavigate("employees")}><ArrowRight size={16} /></button></div>)
              : (data.notifications || []).slice(0, 4).map((item, index) => <div className="attention-item" key={`${item.title}-${index}`}><div className={`attention-symbol symbol-${index % 3}`}><Bell size={15} /></div><div className="attention-text"><strong>{item.title}</strong><span>{item.message}</span></div><time>{new Date(item.created_at).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}</time></div>)}
            {!(admin ? data.pending?.length : data.notifications?.length) && <div className="soft-empty"><div className="soft-empty-icon"><Check size={20} /></div><strong>All caught up</strong><span>Nothing needs your attention right now.</span></div>}
          </div>
          <button className="panel-footer-link" onClick={() => onNavigate(admin ? "employees" : "notifications")}>{admin ? "Review all registrations" : "Open your inbox"} <ArrowRight size={15} /></button>
        </section>
      </div>
      <section className="panel shortcuts-panel"><div className="panel-heading"><div><h3>Quick paths</h3><p>Pick up right where you need to</p></div></div><div className="shortcut-grid">
        {(admin ? [
          { title: user.role === "super_admin" ? "Record attendance" : "Team directory", note: user.role === "super_admin" ? "Mark a team member’s day" : "People & profiles", icon: user.role === "super_admin" ? Clock3 : Users, page: user.role === "super_admin" ? "attendance" : "employees", tone: "violet" },
          { title: "Review time off", note: "Requests & balances", icon: CalendarDays, page: "leaves", tone: "amber" },
          { title: "Prepare payroll", note: "Monthly records", icon: CircleDollarSign, page: "payroll", tone: "green" },
          { title: "Review performance", note: "Monthly growth", icon: TrendingUp, page: "performance", tone: "blue" }
        ] : [
          { title: "View attendance", note: "Your attendance history", icon: Clock3, page: "attendance", tone: "violet" },
          { title: "Request time off", note: "Leave balance & history", icon: CalendarDays, page: "leaves", tone: "amber" },
          { title: "My documents", note: "Your secure files", icon: FileText, page: "documents", tone: "green" },
          { title: "My performance", note: "Monthly progress", icon: TrendingUp, page: "performance", tone: "blue" }
        ]).map((item) => { const Icon = item.icon; return <button className="shortcut" key={item.title} onClick={() => onNavigate(item.page)}><span className={`shortcut-icon ${item.tone}`}><Icon size={18} /></span><span><strong>{item.title}</strong><small>{item.note}</small></span><ArrowRight size={16} /></button>; })}
      </div></section>
    </>
  );
}

function Employees({ data, search, user, onAction, onEditSalary, onRefresh }) {
  const rows = (data.employees || []).filter((person) => [person.full_name, person.email, person.employee_code, person.department, person.designation].join(" ").toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHeading eyebrow="YOUR PEOPLE" title="People directory" subtitle="A connected view of the people that make your team." />
    <div className="stats-row-mini"><span><b>{data.overview?.stats?.employees || 0}</b> active team members</span><span><b>{data.employees?.filter((item) => item.status === "pending").length || 0}</b> pending approvals</span></div>
    <section className="panel table-panel"><div className="panel-heading"><div><h3>Team members</h3><p>Profiles, roles and account status</p></div><button className="button button-secondary button-small" onClick={onRefresh}><Activity size={15} />Refresh</button></div>
      <div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>ROLE</th><th>DEPARTMENT</th><th>JOINED</th><th>STATUS</th>{user.role === "super_admin" && <th>ACTION</th>}</tr></thead><tbody>
        {rows.map((person) => <tr key={person.id}><td><div className="person-cell"><UserAvatar src={person.profile_picture} name={person.full_name || person.email} /><div><strong>{person.full_name || person.email}</strong><small>{person.employee_code} · {person.email}</small></div></div></td><td><span className="role-pill">{person.designation || person.role}</span></td><td>{person.department || "—"}</td><td>{dateLabel(person.joining_date)}</td><td><span className={`status-pill status-${person.status}`}>{person.status}</span></td>{user.role === "super_admin" && <td>{person.status === "pending" ? <div className="row-actions"><button className="approve-button" onClick={() => onAction(`/api/employees/${person.id}/status`, "PATCH", { status: "approved" }, "Employee approved.", "employees")}><Check size={14} />Approve</button><button className="reject-button" onClick={() => onAction(`/api/employees/${person.id}/status`, "PATCH", { status: "rejected" }, "Registration declined.", "employees")}>Decline</button></div> : person.status === "approved" ? <button className="salary-inline" onClick={() => onEditSalary(person)}>Adjust base salary</button> : "—"}</td>}</tr>)}
        {!rows.length && <tr><td colSpan={user.role === "super_admin" ? 6 : 5}><div className="table-empty"><Users size={20} /><strong>{search ? "No matching people" : "No team members yet"}</strong><span>{search ? "Try a different search." : "Approved registrations will appear here."}</span></div></td></tr>}
      </tbody></table></div>
    </section>
  </>;
}

function Attendance({ user, rows, employees, month, onMonthChange, onAction, onRefresh }) {
  const canSeeTeam = ["super_admin", "manager"].includes(user.role);
  const canRecord = user.role === "super_admin";
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState("present");
  const [leaveType, setLeaveType] = useState("medical");
  const [attendanceDate, setAttendanceDate] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  useEffect(() => {
    if (!employees.some((employee) => employee.id === employeeId)) {
      setEmployeeId(employees.find((employee) => employee.status === "approved")?.id || "");
    }
  }, [employees, employeeId]);
  const approvedEmployees = employees.filter((employee) => employee.status === "approved");
  const saveAttendance = () => {
    if (!employeeId) return;
    onAction("/api/attendance", "POST", { userId: employeeId, attendanceDate, status, leaveType: status === "leave" ? leaveType : null }, "Attendance recorded.", "attendance");
  };
  return <>
    <PageHeading eyebrow="TIME & PRESENCE" title="Attendance" subtitle={canRecord ? "Record attendance for approved employees. Only the super admin can make changes." : canSeeTeam ? "View attendance for your team. Records are read-only." : "View your attendance history. Records are read-only."} />
    {canRecord && <section className="panel attendance-admin-panel">
      <div className="panel-heading"><div><h3>Record attendance</h3><p>Choose an employee, date, and attendance status.</p></div></div>
      <div className="attendance-admin-form">
        <label>Employee<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Select an employee</option>{approvedEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.full_name} · {employee.employee_code}</option>)}</select></label>
        <label>Date<input type="date" value={attendanceDate} onChange={(event) => {
          const value = event.target.value;
          setAttendanceDate(value);
          if (value) onMonthChange(value.slice(0, 7));
        }} /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="present">Present</option><option value="absent">Absent</option><option value="half_day">Half day</option><option value="leave">Leave</option></select></label>
        {status === "leave" && <label>Leave type<select value={leaveType} onChange={(event) => setLeaveType(event.target.value)}><option value="medical">Medical leave</option><option value="casual">Casual leave</option><option value="unpaid">Unpaid leave</option></select></label>}
        <button className="button button-primary" onClick={saveAttendance} disabled={!employeeId || !attendanceDate}><Check size={16} />Save attendance</button>
      </div>
    </section>}
    <section className="panel table-panel"><div className="panel-heading"><div><h3>{canSeeTeam ? "Team attendance" : "Your attendance history"}</h3><p>Attendance records for the selected month</p></div><div className="attendance-table-actions"><label>Month<input type="month" value={month} onChange={(event) => { if (event.target.value) onMonthChange(event.target.value); }} /></label><button className="button button-secondary button-small" onClick={onRefresh}><Activity size={15} />Refresh</button></div></div><div className="table-scroll"><table><thead><tr>{canSeeTeam && <th>EMPLOYEE</th>}<th>DATE</th><th>CHECK IN</th><th>CHECK OUT</th><th>WORKING TIME</th><th>STATUS</th><th>LEAVE TYPE</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}>{canSeeTeam && <td>{row.full_name || "Team member"}</td>}<td>{dateLabel(row.attendance_date)}</td><td>{row.check_in ? new Date(row.check_in).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}</td><td>{row.check_out ? new Date(row.check_out).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}</td><td>{row.working_minutes != null ? `${Math.floor(row.working_minutes / 60)}h ${row.working_minutes % 60}m` : "—"}</td><td><span className={`status-pill status-${row.status}`}>{row.status.replace("_", " ")}</span></td><td className="capitalize">{row.leave_type || "—"}</td></tr>)}
      {!rows.length && <tr><td colSpan={canSeeTeam ? 7 : 6}><div className="table-empty"><Clock3 size={20} /><strong>No attendance records for this month</strong><span>Recorded attendance will appear here.</span></div></td></tr>}
    </tbody></table></div></section>
  </>;
}

function HolidayCalendar({ year, holidays, onYearChange }) {
  const holidayByDate = new Map(holidays.map((holiday) => [String(holiday.holiday_date).slice(0, 10), holiday]));
  const months = Array.from({ length: 12 }, (_, month) => {
    const startDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [...Array(startDay).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)];
    while (cells.length % 7) cells.push(null);
    return { month, cells };
  });
  const festivalDays = holidays.slice().sort((left, right) => String(left.holiday_date).localeCompare(String(right.holiday_date)));
  return <>
    <PageHeading eyebrow="PLAN THE YEAR" title="Holiday calendar" subtitle="Weekends are marked as holidays. Festival observances can vary by state and region." />
    <section className="panel holiday-calendar-panel">
      <div className="holiday-calendar-heading"><div><h3>{year} calendar</h3><p>Saturdays and Sundays are non-working days.</p></div><label>Year<select value={year} onChange={(event) => onYearChange(Number(event.target.value))}>{Array.from({ length: 81 }, (_, index) => 2020 + index).map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
      <div className="holiday-legend"><span><i className="calendar-legend-weekend" />Weekend</span><span><i className="calendar-legend-festival" />Festival / public holiday</span></div>
      <div className="year-calendar-grid">{months.map(({ month, cells }) => <article className="calendar-month" key={month}>
        <h4>{new Date(year, month, 1).toLocaleDateString("en-IN", { month: "long" })}</h4>
        <div className="calendar-days calendar-weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
        <div className="calendar-days">{cells.map((day, index) => {
          if (!day) return <span className="calendar-day-empty" key={`empty-${index}`} />;
          const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const holiday = holidayByDate.get(date);
          const weekend = new Date(year, month, day).getDay() === 0 || new Date(year, month, day).getDay() === 6;
          return <span key={date} title={[holiday?.name, weekend ? "Weekend" : ""].filter(Boolean).join(" · ")} className={`calendar-day${weekend ? " calendar-day-weekend" : ""}${holiday ? " calendar-day-holiday" : ""}`}>{day}{holiday && <i />}</span>;
        })}</div>
      </article>)}</div>
    </section>
    <section className="panel holiday-list-panel"><div className="panel-heading"><div><h3>India-wide holidays and festivals</h3><p>Fixed national dates and listed festival observances. Check local schedules for regional holidays.</p></div><span className="panel-count">{festivalDays.length}</span></div>
      <div className="holiday-list">{festivalDays.map((holiday) => <div className="holiday-list-row" key={`${holiday.holiday_date}-${holiday.name}`}><time>{dateLabel(holiday.holiday_date)}</time><strong>{holiday.name}</strong><span>{holiday.category} · {holiday.region}</span></div>)}{!festivalDays.length && <div className="table-empty"><CalendarDays size={20} /><strong>No festival dates listed for {year}</strong><span>Weekend holidays are still marked on the calendar.</span></div>}</div>
    </section>
  </>;
}

function Leaves({ user, rows, balances, onOpen, onReview }) {
  const canReview = ["super_admin", "hr"].includes(user.role);
  const canApprove = user.role === "super_admin";
  return <>
    <PageHeading eyebrow="TIME AWAY, WELL SPENT" title="Time off" subtitle={canApprove ? "Review requests and leave balances. Only the super admin can approve requests." : canReview ? "View team requests. Only the super admin can approve or reject leave." : "Plan a little space to rest, recharge and reset."} buttonText={!canReview ? "Request time off" : undefined} action={onOpen} />
    {!canReview && <div className="balance-grid">{balances.map((balance) => <div className="balance-card" key={balance.leave_type}><div className={`balance-icon ${balance.leave_type}`}><CalendarDays size={18} /></div><div><span>{balance.leave_type} leave</span><strong>{Number(balance.remaining).toFixed(balance.remaining % 1 ? 1 : 0)} <small>days left</small></strong><div className="balance-track"><i style={{ width: `${Math.min(100, Number(balance.remaining) / Math.max(1, Number(balance.allowance)) * 100)}%` }} /></div></div><small>{balance.used} of {balance.allowance} used</small></div>)}</div>}
    <section className="panel table-panel"><div className="panel-heading"><div><h3>{canReview ? "Leave requests" : "Your requests"}</h3><p>{canApprove ? "Pending decisions and request history" : canReview ? "Team request history" : "Your submitted time-off requests"}</p></div><span className="panel-count">{rows.filter((row) => row.status === "pending").length} pending</span></div><div className="table-scroll"><table><thead><tr>{canReview && <th>EMPLOYEE</th>}<th>TYPE</th><th>DATES</th><th>DAYS</th><th>REASON</th><th>STATUS</th>{canApprove && <th>ACTION</th>}</tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}>{canReview && <td><div className="person-cell"><div className="avatar">{(row.full_name || "T")[0]}</div><strong>{row.full_name}</strong></div></td>}<td className="capitalize">{row.leave_type}</td><td>{dateLabel(row.start_date)} – {dateLabel(row.end_date)}</td><td>{row.days}</td><td className="reason-cell">{row.reason}</td><td><span className={`status-pill status-${row.status}`}>{row.status}</span></td>{canApprove && <td>{row.status === "pending" ? <div className="row-actions"><button className="approve-button" onClick={() => onReview(row.id, "approved")}><Check size={14} />Approve</button><button className="reject-button" onClick={() => onReview(row.id, "rejected")}>Decline</button></div> : "—"}</td>}</tr>)}
      {!rows.length && <tr><td colSpan={canApprove ? 7 : canReview ? 6 : 5}><div className="table-empty"><CalendarDays size={20} /><strong>No leave requests yet</strong><span>Requests will appear here when submitted.</span></div></td></tr>}
    </tbody></table></div></section>
  </>;
}

function Payroll({ rows, user, monthlySalary, onOpen, onEdit, onPay }) {
  const canManage = user.role === "super_admin";
  const total = rows.filter((row) => row.payment_status !== "paid").reduce((sum, row) => sum + Number(row.net_pay), 0);
  return <>
    <PageHeading eyebrow="PAY, THOUGHTFULLY MANAGED" title={canManage ? "Payroll" : "My salary"} subtitle={canManage ? "Review attendance and performance, then manually edit the salary figures before confirming payment. No automatic pay formula is applied." : "Your current base salary and payment history. Salary details are read-only."} buttonText={canManage ? "Generate payroll" : undefined} action={onOpen} />
    {!canManage && <section className="salary-readonly-card"><div className="salary-readonly-icon"><CircleDollarSign size={19} /></div><div><span>Current monthly base salary</span><strong>{monthlySalary == null ? "Not available" : money(monthlySalary)}</strong><small>Visible to you only. Salary changes can only be made by the super admin.</small></div></section>}
    <div className="payroll-banner"><div><span className="section-kicker">AWAITING PAYMENT</span><strong>{money(total)}</strong><small>Across {rows.filter((row) => row.payment_status !== "paid").length} pending records</small></div><div className="payroll-banner-icon"><CircleDollarSign size={28} /></div><div className="payroll-month"><span>Records in workspace</span><strong>{rows.length}</strong><small>Every payment is marked manually</small></div></div>
    <section className="panel table-panel"><div className="panel-heading"><div><h3>Salary records</h3><p>Monthly attendance and performance are shown for manual payroll review.</p></div></div><div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>MONTH</th>{canManage && <th>UPI ID</th>}<th>PRESENT / HALF / ABSENT</th><th>LEAVE (M / C / U)</th><th>PERFORMANCE</th><th>BASE PAY</th><th>BONUS</th><th>DEDUCTIONS</th><th>NET PAY</th><th>STATUS</th>{canManage && <th>ACTION</th>}</tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{user.role === "super_admin" || user.role === "hr" ? <div className="person-cell"><div className="avatar">{(row.full_name || "T")[0]}</div><div><strong>{row.full_name}</strong><small>{row.employee_code}</small></div></div> : <strong>{user.fullName}</strong>}</td><td>{new Date(row.pay_month).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</td>{canManage && <td>{row.upi_id || "—"}</td>}<td>{row.present_days} / {row.half_day_days} / {row.absent_days}</td><td>{row.medical_leave_days} / {row.casual_leave_days} / {row.unpaid_leave_days}</td><td>{row.performance_score == null ? "—" : `${Math.round(Number(row.performance_score))}%`}</td><td>{money(row.base_salary)}</td><td>{money(row.bonus)}</td><td>{money(row.deductions)}</td><td><strong>{money(row.net_pay)}</strong></td><td><span className={`status-pill status-${row.payment_status}`}>{row.payment_status}</span></td>{canManage && <td><div className="row-actions">{row.payment_status !== "paid" && <button className="salary-inline" onClick={() => onEdit(row)}>Edit</button>}{row.payment_status === "pending" ? <button className="approve-button" onClick={() => onPay(row.id, "paid")}><Check size={14} />Mark paid</button> : row.payment_status === "failed" ? <button className="text-button" onClick={() => onPay(row.id, "paid")}>Retry status</button> : <span className="paid-note"><Check size={14} />Confirmed</span>}</div></td>}</tr>)}
      {!rows.length && <tr><td colSpan={canManage ? 12 : 10}><div className="table-empty"><CircleDollarSign size={20} /><strong>{canManage ? "No salary records yet" : "No salary records available"}</strong><span>{canManage ? "Generate payroll to prepare records for administrator review." : "Your salary statements will appear here after the super admin generates payroll."}</span></div></td></tr>}
    </tbody></table></div></section>
  </>;
}

function Performance({ user, rows, employees, onOpen }) {
  const canWrite = ["super_admin", "manager"].includes(user.role);
  return <>
    <PageHeading eyebrow="GROWTH, IN FOCUS" title="Performance" subtitle={canWrite ? "Make monthly feedback clear, useful and actionable." : "Your growth, recognized and recorded over time."} buttonText={canWrite ? "New review" : undefined} action={onOpen} />
    <section className="panel performance-intro"><div className="performance-badge"><TrendingUp size={21} /></div><div><strong>Thoughtful feedback builds momentum.</strong><p>Scores are weighted across task completion (25%), productivity (20%), quality (20%), attendance (15%), teamwork (10%) and communication (10%).</p></div><span>OUT OF 100</span></section>
    <div className="review-grid">{rows.map((row) => {
      const score = Math.round(Number(row.overall_score));
      const grade = score >= 90 ? "Excellent" : score >= 75 ? "Very good" : score >= 60 ? "Good" : score >= 40 ? "Needs improvement" : "Poor";
      return <article className="review-card" key={row.id}><div className="review-card-top"><div><div className="section-kicker">{new Date(row.review_month).toLocaleDateString("en-IN", { month: "long", year: "numeric" }).toUpperCase()}</div><h3>{row.full_name || user.fullName}</h3><p>{row.employee_code || user.designation || "Monthly review"}</p></div><div className={`score-circle ${score >= 75 ? "score-high" : score >= 60 ? "score-mid" : "score-low"}`}><strong>{score}</strong><small>/100</small></div></div><span className={`grade grade-${score >= 75 ? "good" : "watch"}`}>{grade}</span><div className="review-meter"><i style={{ width: `${score}%` }} /></div>{row.feedback && <div className="review-quote"><span>MANAGER FEEDBACK</span><p>{row.feedback}</p></div>}{row.suggestions && <div className="review-suggestion"><Sparkles size={15} /><span>{row.suggestions}</span></div>}</article>;
    })}{!rows.length && <div className="empty-panel review-empty"><div className="soft-empty-icon"><TrendingUp size={20} /></div><strong>No reviews published yet</strong><span>{canWrite ? `Create a monthly review${employees.length ? " for a team member" : ""} when you’re ready.` : "Your monthly performance reports will show up here."}</span></div>}</div>
  </>;
}

function Documents({ rows, dropbox, onUpload, onDelete }) {
  const [category, setCategory] = useState("other");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);
  const uploadFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    body.append("category", category);
    setUploading(true);
    try { await onUpload(body); } finally { setUploading(false); event.target.value = ""; }
  };
  const download = async (id, name) => {
    try {
      const response = await fetch(`/api/documents/${id}/download`, { credentials: "include" });
      if (!response.ok) throw new Error("Document could not be downloaded.");
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) { window.alert(error.message); }
  };
  return <>
    <PageHeading eyebrow="YOUR FILES, IN ONE PLACE" title="Documents" subtitle="A secure place for the important things you need to keep close." />
    <section className="dropbox-status-panel">
      <div><strong>{dropbox?.connected ? "Personal Dropbox connected" : "Personal Dropbox not connected"}</strong><span>{dropbox?.connected ? `${dropbox.email} · new documents upload to this account` : dropbox?.configured ? "Connect Dropbox to store your documents there. Until then, they stay in private app storage." : "Dropbox needs administrator setup. Until then, documents stay in private app storage."}</span></div>
      {dropbox?.configured && !dropbox.connected && <a className="button button-secondary button-small" href="/api/dropbox/connect">Connect Dropbox</a>}
    </section>
    <section className="upload-panel"><div className="upload-icon"><Upload size={20} /></div><div className="upload-copy"><strong>Drop a file into your workspace</strong><span>PDF, JPG, PNG, DOC or DOCX · up to 10 MB</span></div><div className="upload-actions"><select aria-label="Document category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="other">Other document</option><option value="resume">Resume</option><option value="identity">Identity document</option><option value="education">Education certificate</option><option value="internship">Internship certificate</option><option value="experience">Experience letter</option><option value="salary">Salary document</option></select><button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? <span className="spinner" /> : <Upload size={16} />}Choose file</button><input ref={fileInput} hidden type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,image/*" capture="environment" onChange={uploadFile} /></div></section>
    <section className="panel document-panel"><div className="panel-heading"><div><h3>Your documents</h3><p>Only you and authorized people administrators can access these files.</p></div><span className="panel-count">{rows.length} files</span></div><div className="document-list">
      {rows.map((document) => <div className="document-row" key={document.id}><div className="document-type-icon"><FileText size={19} /></div><div className="document-name"><strong>{document.file_name}</strong><span>{document.category} · {document.storage_provider || "Private storage"} · {(Number(document.file_size) / 1024).toFixed(0)} KB · {dateLabel(document.uploaded_at)}</span></div><button className="icon-button" aria-label={`Download ${document.file_name}`} onClick={() => download(document.id, document.file_name)}><ArrowDownToLine size={17} /></button><button className="icon-button delete-icon" aria-label={`Delete ${document.file_name}`} onClick={() => onDelete(document.id)}><X size={17} /></button></div>)}
      {!rows.length && <div className="table-empty"><FileText size={20} /><strong>No documents uploaded</strong><span>Your uploaded documents will be listed here.</span></div>}
    </div></section>
  </>;
}

function Notifications({ rows }) {
  return <>
    <PageHeading eyebrow="STAY IN THE LOOP" title="Inbox" subtitle="A small signal for the things that matter." />
    <section className="panel notification-list-panel"><div className="panel-heading"><div><h3>Recent notifications</h3><p>Workspace updates and your personal notifications</p></div><span className="panel-count">{rows.length}</span></div>
      {rows.map((row, index) => <article className="notification-row" key={row.id || `${row.title}-${index}`}><div className={`attention-symbol symbol-${index % 3}`}><Bell size={16} /></div><div><strong>{row.title}</strong><p>{row.message}</p><time>{new Date(row.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time></div><span className="notification-unread" /> </article>)}
      {!rows.length && <div className="table-empty"><Bell size={20} /><strong>You’re all caught up</strong><span>New activity will find its way here.</span></div>}
    </section>
  </>;
}

function Messages({ user, conversations, selectedEmployeeId, messages, onSelect, onSend, onRequestLeave, onReviewLeave }) {
  const [draft, setDraft] = useState("");
  const isAdmin = user.role === "super_admin";
  const selected = conversations.find((item) => item.employee_id === selectedEmployeeId);
  const send = (event) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    onSend(message);
    setDraft("");
  };
  return <>
    <PageHeading eyebrow="TEAM CONVERSATIONS" title="Messages" subtitle={isAdmin ? "Private employee conversations and leave decisions." : "Send a private message or leave request to your super admin."} />
    <section className={`messages-layout panel${isAdmin ? " messages-admin" : ""}`}>
      {isAdmin && <aside className="conversation-list" aria-label="Employee conversations">
        <h3>Employees</h3>
        {conversations.map((conversation) => <button key={conversation.employee_id} className={`conversation-item${selectedEmployeeId === conversation.employee_id ? " selected" : ""}`} onClick={() => onSelect(conversation.employee_id)}>
          <span className="avatar">{(conversation.full_name || "?")[0]}</span><span className="conversation-copy"><strong>{conversation.full_name}</strong><small>{conversation.last_message || conversation.employee_code || "Start a conversation"}</small></span>{conversation.unread_count > 0 && <i className="conversation-unread">{conversation.unread_count}</i>}
        </button>)}
      </aside>}
      <div className="conversation-thread">
        <header className="conversation-header"><div className="avatar">{(isAdmin ? selected?.full_name : "Admin")?.[0] || "?"}</div><div><strong>{isAdmin ? selected?.full_name || "Choose an employee" : "Super admin"}</strong><small>{isAdmin ? selected?.employee_code || "Employee conversation" : "Private conversation"}</small></div>{!isAdmin && <button className="button button-secondary button-small" onClick={onRequestLeave}><CalendarDays size={15} />Request leave</button>}</header>
        <div className="message-list" aria-live="polite">
          {messages.map((message) => <article key={message.id} className={`chat-message${message.sender_id === user.id ? " own-message" : ""}`}>
            <div className="chat-message-meta"><strong>{message.sender_id === user.id ? "You" : message.sender_name || (message.sender_role === "super_admin" ? "Super admin" : "Administrator")}</strong><time>{new Date(message.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time></div>
            <p>{message.body}</p>
            {message.leave_request_id && <div className="chat-leave-card"><div><strong>{message.leave_type} leave · {message.leave_status}</strong><span>{dateLabel(message.start_date)} – {dateLabel(message.end_date)} · {message.leave_days} day(s)</span><small>{message.leave_reason}</small></div>{isAdmin && message.leave_status === "pending" && <div className="row-actions"><button className="approve-button" onClick={() => onReviewLeave(message.leave_request_id, "approved")}><Check size={14} />Approve</button><button className="reject-button" onClick={() => onReviewLeave(message.leave_request_id, "rejected")}>Decline</button></div>}</div>}
          </article>)}
          {!messages.length && <div className="table-empty"><MessageCircle size={20} /><strong>{isAdmin && !selected ? "Select an employee" : "Start the conversation"}</strong><span>Messages and leave decisions will appear here.</span></div>}
        </div>
        <form className="message-compose" onSubmit={send}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} rows="2" placeholder="Write a message to the super admin…" aria-label="Message" /><button className="button button-primary" disabled={!draft.trim() || (isAdmin && !selectedEmployeeId)}><MessageCircle size={16} />Send</button></form>
      </div>
    </section>
  </>;
}

function Modal({ type, form, setForm, busy, employees, user, onClose, onSubmit }) {
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const titles = {
    leave: ["Request time off", "Your request will be sent to your super admin for review."],
    payroll: ["Prepare monthly payroll", "Create draft salary records. No money will be transferred."],
    performance: ["Monthly performance review", "Scores are weighted automatically to create the final result."],
    employeeSalary: ["Adjust monthly base salary", `Set the ongoing base salary for ${form.fullName || "this employee"}. Existing payroll records will not change.`],
    salaryRecord: ["Edit monthly salary record", `Correct the draft figures for ${form.fullName || "this employee"}. Net pay will be recomputed.`]
  };
  const [title, subtitle] = titles[type];
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-heading"><div className="modal-heading"><div><span className="section-kicker">V_SOLUTIONS</span><h2 id="modal-heading">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
    <form className="modal-form" onSubmit={onSubmit}>
      {type === "leave" && <><label>Leave type<select required value={form.leaveType || ""} onChange={set("leaveType")}><option value="" disabled>Select leave type</option><option value="medical">Medical leave</option><option value="casual">Casual leave</option><option value="unpaid">Unpaid leave</option></select></label><div className="form-grid"><label>Start date<input type="date" required value={form.startDate || ""} onChange={set("startDate")} /></label><label>End date<input type="date" required value={form.endDate || ""} onChange={set("endDate")} /></label></div><label>Reason<textarea required minLength="5" maxLength="1000" rows="3" value={form.reason || ""} onChange={set("reason")} placeholder="A short note to help your admin plan…" /></label></>}
      {type === "payroll" && <><label>Payroll month<input type="month" required value={form.payMonth || ""} onChange={set("payMonth")} /></label><div className="form-grid"><label>Bonus per employee (₹)<input type="number" min="0" step="100" value={form.bonus ?? 0} onChange={set("bonus")} /></label><label>Deduction per employee (₹)<input type="number" min="0" step="100" value={form.deductions ?? 0} onChange={set("deductions")} /></label></div><div className="inline-notice"><ShieldCheck size={16} />Generated records are drafts for manual review. You’ll confirm each payment separately.</div></>}
      {type === "employeeSalary" && <><label>Monthly base salary (₹)<input type="number" min="1" max="10000000" step="0.01" required value={form.monthlySalary ?? ""} onChange={set("monthlySalary")} /></label><div className="inline-notice"><ShieldCheck size={16} />This updates future payroll generation. To fix a generated month, edit its salary record in Payroll.</div></>}
      {type === "salaryRecord" && <><label>Base salary (₹)<input type="number" min="0" max="10000000" step="0.01" required value={form.baseSalary ?? ""} onChange={set("baseSalary")} /></label><div className="form-grid"><label>Bonus (₹)<input type="number" min="0" max="10000000" step="0.01" required value={form.bonus ?? 0} onChange={set("bonus")} /></label><label>Deductions (₹)<input type="number" min="0" max="10000000" step="0.01" required value={form.deductions ?? 0} onChange={set("deductions")} /></label></div><div className="inline-notice"><ShieldCheck size={16} />Attendance and performance are visible in the payroll list for manual review; no automatic salary formula is applied.</div></>}
      {type === "performance" && <><label>Team member<select required value={form.userId || ""} onChange={set("userId")}><option value="">Select a person</option>{employees.filter((item) => item.status === "approved").map((person) => <option value={person.id} key={person.id}>{person.full_name} · {person.employee_code}</option>)}</select></label><label>Review month<input type="month" required value={form.reviewMonth || ""} onChange={set("reviewMonth")} /></label><div className="score-form-grid">{[["taskCompletion", "Task completion", 25], ["productivity", "Productivity", 20], ["quality", "Quality of work", 20], ["attendance", "Attendance", 15], ["teamwork", "Teamwork", 10], ["communication", "Communication", 10]].map(([key, label, weight]) => <label key={key}>{label}<span>{weight}% weight</span><input type="number" min="0" max="100" required value={form[key] ?? 80} onChange={set(key)} /></label>)}</div><label>Manager feedback<textarea rows="2" maxLength="2000" value={form.feedback || ""} onChange={set("feedback")} /></label><label>Improvement suggestions<textarea rows="2" maxLength="2000" value={form.suggestions || ""} onChange={set("suggestions")} /></label></>}
      <div className="modal-footer"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? <span className="spinner" /> : <Check size={16} />}{type === "leave" ? "Submit request" : type === "payroll" ? "Generate records" : type === "performance" ? "Publish review" : "Save changes"}</button></div>
    </form>
  </section></div>;
}

export default App;
