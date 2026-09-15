import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { track, getEvents, subscribe } from "./analytics";
import { navigate, useRoute } from "./router";

const deployments = [
  { id: "dep-101", service: "api-gateway", env: "production", provider: "AWS", region: "us-east-1", status: "running", version: "v2.4.1", lastDeployed: "2026-09-02 14:12" },
  { id: "dep-102", service: "auth-service", env: "production", provider: "AWS", region: "us-east-1", status: "running", version: "v1.9.0", lastDeployed: "2026-09-01 09:47" },
  { id: "dep-103", service: "billing-worker", env: "staging", provider: "GCP", region: "europe-west1", status: "pending", version: "v3.1.0-rc2", lastDeployed: "2026-09-03 08:20" },
  { id: "dep-104", service: "notification-svc", env: "production", provider: "Azure", region: "eastus", status: "failed", version: "v0.8.3", lastDeployed: "2026-08-31 22:05" },
  { id: "dep-105", service: "frontend-app", env: "production", provider: "AWS", region: "us-west-2", status: "running", version: "v5.0.2", lastDeployed: "2026-09-02 18:30" },
  { id: "dep-106", service: "search-index", env: "staging", provider: "GCP", region: "us-central1", status: "running", version: "v1.2.4", lastDeployed: "2026-08-29 11:15" },
  { id: "dep-107", service: "data-pipeline", env: "development", provider: "AWS", region: "us-east-1", status: "pending", version: "v0.3.0", lastDeployed: "2026-09-03 07:02" },
  { id: "dep-108", service: "payments-api", env: "production", provider: "Azure", region: "westeurope", status: "running", version: "v4.2.0", lastDeployed: "2026-08-30 16:40" },
  { id: "dep-109", service: "recommendation-engine", env: "staging", provider: "GCP", region: "asia-east1", status: "failed", version: "v2.0.1", lastDeployed: "2026-09-01 20:18" },
  { id: "dep-110", service: "cache-layer", env: "development", provider: "AWS", region: "us-east-2", status: "running", version: "v1.0.5", lastDeployed: "2026-09-02 10:55" },
];

const routes = {
  "/": "Dashboard",
  "/deployments": "Deployments",
  "/settings": "Settings",
};
const pathsByPage = { Dashboard: "/", Deployments: "/deployments", Settings: "/settings" };
const pages = ["Dashboard", "Deployments", "Settings"];

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function DashboardPage({ counts }) {
  return (
    <div className="summary">
      <div className="summary-card">
        <div className="count">{deployments.length}</div>
        <div className="label">Total Deployments</div>
      </div>
      <div className="summary-card">
        <div className="count running">{counts.running || 0}</div>
        <div className="label">Running</div>
      </div>
      <div className="summary-card">
        <div className="count pending">{counts.pending || 0}</div>
        <div className="label">Pending</div>
      </div>
      <div className="summary-card">
        <div className="count failed">{counts.failed || 0}</div>
        <div className="label">Failed</div>
      </div>
    </div>
  );
}

function DeploymentsPage({ query, setQuery, envFilter, setEnvFilter, statusFilter, setStatusFilter, environments, statuses, filtered, onRefresh, onExport }) {
  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search by service, provider, or region..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}>
          {environments.map((env) => (
            <option key={env} value={env}>
              {env === "all" ? "All environments" : env}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s}
            </option>
          ))}
        </select>
        <button className="btn" onClick={onRefresh}>Refresh</button>
        <button className="btn" onClick={onExport}>Export</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>Environment</th>
            <th>Provider / Region</th>
            <th>Status</th>
            <th>Version</th>
            <th>Last Deployed</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((d) => (
            <tr key={d.id}>
              <td>{d.service}</td>
              <td>{d.env}</td>
              <td className="provider">
                {d.provider} · {d.region}
              </td>
              <td>
                <StatusBadge status={d.status} />
              </td>
              <td>{d.version}</td>
              <td>{d.lastDeployed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <div className="empty">No deployments match your filters.</div>}
    </>
  );
}

function SettingsPage() {
  return (
    <div className="settings">
      <p>Nothing configurable yet — this page exists to test page-view tracking on navigation.</p>
    </div>
  );
}

function AnalyticsLog({ events }) {
  return (
    <div className="analytics-log">
      <div className="analytics-log-header">Analytics Log ({events.length})</div>
      <div className="analytics-log-body">
        {events.length === 0 && <div className="empty">No events yet — switch tabs or click a button.</div>}
        {[...events].reverse().map((e, i) => (
          <div className="analytics-event" key={i}>
            <span className="event-name">{e.eventName}</span>
            <span className="event-payload">{JSON.stringify(e.payload)}</span>
            <span className="event-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const path = useRoute();
  const page = routes[path] || "Dashboard";
  const [query, setQuery] = useState("");
  const [envFilter, setEnvFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [events, setEvents] = useState(getEvents());

  useEffect(() => subscribe(setEvents), []);

  useEffect(() => {
    track("page_view", { page });
  }, [page]);

  const environments = useMemo(() => ["all", ...new Set(deployments.map((d) => d.env))], []);
  const statuses = useMemo(() => ["all", ...new Set(deployments.map((d) => d.status))], []);

  const counts = useMemo(() => {
    const c = { running: 0, pending: 0, failed: 0 };
    deployments.forEach((d) => {
      c[d.status] = (c[d.status] || 0) + 1;
    });
    return c;
  }, []);

  const filtered = useMemo(() => {
    return deployments.filter((d) => {
      const matchesQuery = (d.service + d.provider + d.region)
        .toLowerCase()
        .includes(query.toLowerCase());
      const matchesEnv = envFilter === "all" || d.env === envFilter;
      const matchesStatus = statusFilter === "all" || d.status === statusFilter;
      return matchesQuery && matchesEnv && matchesStatus;
    });
  }, [query, envFilter, statusFilter]);

  return (
    <>
      <header>
        <h1>Cloud Deployments Explorer</h1>
        <p>Browse and filter deployments across environments and cloud providers</p>
        <nav className="tabs">
          {pages.map((p) => (
            <button
              key={p}
              className={`tab ${page === p ? "active" : ""}`}
              onClick={() => navigate(pathsByPage[p])}
            >
              {p}
            </button>
          ))}
        </nav>

        <br/>
        <button
          className="btn"
          onClick={() =>
            window.open(
              "https://365tours-prototype.netlify.app/?utm_source=zenithlab&utm_medium=button&utm_campaign=365tours_redirect",
              "_blank",
              "noopener,noreferrer"
            )
          }
        >
          Visit 365Tours
        </button>
      </header>
      <main>
        {page === "Dashboard" && <DashboardPage counts={counts} />}
        {page === "Deployments" && (
          <DeploymentsPage
            query={query}
            setQuery={setQuery}
            envFilter={envFilter}
            setEnvFilter={setEnvFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            environments={environments}
            statuses={statuses}
            filtered={filtered}
            onRefresh={() => track("button_click", { button: "refresh" })}
            onExport={() => track("button_click", { button: "export" })}
          />
        )}
        {page === "Settings" && <SettingsPage />}

        <AnalyticsLog events={events} />
      </main>
    </>
  );
}

export default App;
