import { useState } from "react";
import { useAuth } from "./Auth";
import { AccountSettingsDialog } from "./AccountSettings";
import { SessionIdentity } from "./OperatorAccess";
import Icon from "./Icon";
import "./workspaceHeader.css";

export default function WorkspaceHeader({ page }: { page: "projects" | "gateway" }) {
  const { audience, gatewayAdmin } = useAuth();
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const operator = audience === "operator";
  return <>
    <header className="workspace-header"><div className="workspace-header-inner">
      <a className="workspace-brand" href={operator ? "/?audience=operator" : "/"}><span className="brand-mark"><Icon name="spark" size={24} /></span><strong>spark<span>studio</span></strong></a>
      <div className="workspace-header-actions">
        {page === "gateway" ? <a className="workspace-header-link" href="/">Projects</a> : gatewayAdmin && !operator && <a className="workspace-header-link" href="/gateway">Settings</a>}
        <SessionIdentity operator={operator} iconOnlySignOut onAccountSettings={() => setAccountSettingsOpen(true)} />
      </div>
    </div></header>
    {accountSettingsOpen && <AccountSettingsDialog onClose={() => setAccountSettingsOpen(false)} />}
  </>;
}
