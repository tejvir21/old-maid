import { useEffect, useMemo } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { AdminGate, AdminProvider } from "./admin/AdminProvider";
import { AdminLogin } from "./admin/pages/AdminLogin";
import { AdminDashboard } from "./admin/pages/AdminDashboard";
import { AdminUsers } from "./admin/pages/AdminUsers";
import { AdminRooms } from "./admin/pages/AdminRooms";
import { AdminGames } from "./admin/pages/AdminGames";
import { AdminReports } from "./admin/pages/AdminReports";
import { AdminStatistics } from "./admin/pages/AdminStatistics";
import { AdminSettings } from "./admin/pages/AdminSettings";
import { AdminDatabase } from "./admin/pages/AdminDatabase";
import { AdminAuditLogs } from "./admin/pages/AdminAuditLogs";
import { AdminAdmins } from "./admin/pages/AdminAdmins";
import { AdminSystemHealth } from "./admin/pages/AdminSystemHealth";
import { AdminApi } from "./admin/adminApi";
import { useServices } from "./app/context";
import { Home } from "./pages/Home";
import { OfflinePlay } from "./pages/OfflinePlay";
import { OfflineSetup } from "./pages/OfflineSetup";
import { OnlineMenu } from "./pages/OnlineMenu";
import { OnlineRoom } from "./pages/OnlineRoom";
import { Rules } from "./pages/Rules";
import { Settings } from "./pages/Settings";
import { Stats } from "./pages/Stats";
import { configureSound } from "./sound/sound";
import { useSettingsStore } from "./store/ui";

function NotFound() {
  return (
    <div className="room flex min-h-full flex-col items-center justify-center gap-4">
      <h1 className="title-display text-4xl">Nothing here</h1>
      <Link to="/" className="btn">Main menu</Link>
    </div>
  );
}

export function App() {
  const svc = useServices();
  const settings = useSettingsStore((s) => s.values);
  // The admin API client reuses the app's API base but keeps its own session + token.
  const adminApi = useMemo(() => new AdminApi(svc.opts.apiUrl), [svc.opts.apiUrl]);

  useEffect(() => {
    document.documentElement.dataset["theme"] = settings.theme;
    document.documentElement.classList.toggle("no-motion", !settings.animations);
    configureSound({ sound: settings.sound, music: settings.music });
  }, [settings.theme, settings.animations, settings.sound, settings.music]);

  // Browsers only allow audio after a gesture; make sure music can start on the first interaction.
  useEffect(() => {
    const kick = () => configureSound({ sound: settings.sound, music: settings.music });
    window.addEventListener("pointerdown", kick, { once: true });
    return () => window.removeEventListener("pointerdown", kick);
  }, [settings.sound, settings.music]);

  useEffect(() => { svc.start(); return () => svc.stop(); }, [svc]);

  return (
    <AdminProvider api={adminApi}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/offline" element={<OfflineSetup />} />
        <Route path="/offline/play" element={<OfflinePlay />} />
        <Route path="/online" element={<OnlineMenu />} />
        <Route path="/online/room" element={<OnlineRoom />} />

        {/* Phase 4 admin panel. The route guard is UX only — every API call is
            independently authorized on the server. */}
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminGate><AdminDashboard /></AdminGate>} />
        <Route path="/admin/users" element={<AdminGate need="USERS_READ"><AdminUsers /></AdminGate>} />
        <Route path="/admin/rooms" element={<AdminGate need="ROOMS_READ"><AdminRooms /></AdminGate>} />
        <Route path="/admin/games" element={<AdminGate need="GAMES_READ"><AdminGames /></AdminGate>} />
        <Route path="/admin/reports" element={<AdminGate need="REPORTS_READ"><AdminReports /></AdminGate>} />
        <Route path="/admin/statistics" element={<AdminGate need="SETTINGS_READ"><AdminStatistics /></AdminGate>} />
        <Route path="/admin/settings" element={<AdminGate need="SETTINGS_READ"><AdminSettings /></AdminGate>} />
        <Route path="/admin/database" element={<AdminGate need="DATABASE_READ"><AdminDatabase /></AdminGate>} />
        <Route path="/admin/audit-logs" element={<AdminGate need="AUDIT_READ"><AdminAuditLogs /></AdminGate>} />
        <Route path="/admin/admins" element={<AdminGate need="ADMINS_READ"><AdminAdmins /></AdminGate>} />
        <Route path="/admin/system-health" element={<AdminGate need="SETTINGS_READ"><AdminSystemHealth /></AdminGate>} />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </AdminProvider>
  );
}
