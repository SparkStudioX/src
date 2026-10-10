; SparkStudio preview installer. Compile with tools/build-installer.ps1.
#ifndef PayloadDir
  #error PayloadDir must point to the verified offline package stage.
#endif
#ifndef OutputFolder
  #error OutputFolder is required.
#endif
#ifndef AppVersion
  #define AppVersion "0.2.0-preview.16"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.2.0.16"
#endif

[Setup]
AppId={{C85DA4EA-0382-4B12-943A-CE73A1772FD8}
AppName=SparkStudio
AppVersion={#AppVersion}
AppVerName=SparkStudio {#AppVersion}
AppPublisher=SparkStudio
AppComments=Unsigned internal preview. Local or network HTTPS gateway with an offline Python runtime.
VersionInfoDescription=SparkStudio offline Windows installer (unsigned preview)
VersionInfoVersion={#NumericVersion}
VersionInfoProductVersion={#NumericVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
DefaultDirName={code:DefaultDirectory}
DefaultGroupName=SparkStudio
DisableProgramGroupPage=yes
UsePreviousAppDir=not PortableMode
Uninstallable=not PortableMode
CreateUninstallRegKey=not PortableMode
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupArchitecture=x64
MinVersion=10.0.17763
OutputDir={#OutputFolder}
OutputBaseFilename=SparkStudio-Setup-{#AppVersion}-windows-x64-unsigned
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
SetupLogging=yes
UninstallDisplayIcon={app}\SparkStudio.Gateway.exe
InfoBeforeFile=INSTALL-NOTES.txt
UninstallDisplayName=SparkStudio {#AppVersion}

[Tasks]
Name: desktopicon; Description: "Create Designer and Runtime desktop shortcuts"; Flags: unchecked; Check: not PortableMode

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\SparkStudio.ServiceHelper.exe"; Flags: dontcopy

[Icons]
Name: "{group}\SparkStudio Designer"; Filename: "{code:DesignerUrl}"; Check: not PortableMode
Name: "{group}\SparkStudio Runtime"; Filename: "{code:RuntimeUrl}"; Check: not PortableMode
Name: "{group}\Uninstall SparkStudio"; Filename: "{uninstallexe}"; Check: not PortableMode
Name: "{autodesktop}\SparkStudio Designer"; Filename: "{code:DesignerUrl}"; Tasks: desktopicon; Check: not PortableMode
Name: "{autodesktop}\SparkStudio Runtime"; Filename: "{code:RuntimeUrl}"; Tasks: desktopicon; Check: not PortableMode

[Run]
Filename: "{code:DesignerUrl}"; Description: "Open SparkStudio Designer"; Flags: shellexec postinstall skipifsilent runasoriginaluser; Check: not PortableMode

[Code]
var
  AccessPage, CertificateModePage: TInputOptionWizardPage;
  PortPage, NetworkPage: TInputQueryWizardPage;
  CertificatePage: TInputFileWizardPage;
  HasManagedInstallation: Boolean;
  HelperPath: String;
  ServiceStopped, ServiceInstalled: Boolean;

function PortableMode: Boolean;
begin
  Result := ExpandConstant('{param:PORTABLE|0}') = '1';
end;

function DefaultDirectory(Param: String): String;
begin
  if PortableMode then Result := ExpandConstant('{localappdata}\SparkStudio Preview')
  else Result := ExpandConstant('{autopf}\SparkStudio');
end;

function SelectedPort: String;
begin
  Result := Trim(PortPage.Values[0]);
end;

function SelectedAccess: String;
begin
  if AccessPage.SelectedValueIndex = 1 then Result := 'network'
  else if AccessPage.SelectedValueIndex = 2 then Result := 'keep'
  else Result := 'local';
end;

function SelectedCertificateMode: String;
begin
  if CertificateModePage.SelectedValueIndex = 1 then Result := 'provided'
  else Result := 'self-signed';
end;

function QuotedArgument(Value: String): String;
begin
  if (Pos('"', Value) > 0) or (Pos(#13, Value) > 0) or (Pos(#10, Value) > 0) then
    RaiseException('Configuration values cannot contain quotes or new lines.');
  Result := '"' + Value + '"';
end;

function DesignerUrl(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + SelectedPort + '/';
end;

function RuntimeUrl(Param: String): String;
begin
  Result := DesignerUrl('') + 'runtime';
end;

function ValidPort: Boolean;
var Port: Integer;
begin
  Port := StrToIntDef(SelectedPort, 0);
  Result := (Port >= 1024) and (Port <= 65535) and (IntToStr(Port) = SelectedPort);
end;

function RunHelper(Action, DirectoryName, Executable: String; var MessageText: String): Boolean;
var ExitCode: Integer; ReportPath, Arguments: String; Contents: AnsiString;
begin
  ReportPath := ExpandConstant('{tmp}\sparkstudio-service-result.txt');
  DeleteFile(ReportPath);
  Arguments := '--action ' + Action + ' --install-dir "' + DirectoryName +
    '" --port ' + SelectedPort + ' --report "' + ReportPath + '"';
  if (Action = 'preflight') or (Action = 'prepare') or (Action = 'install') then begin
    Arguments := Arguments + ' --access ' + SelectedAccess;
    if SelectedAccess = 'network' then begin
      Arguments := Arguments + ' --https-port ' + QuotedArgument(Trim(NetworkPage.Values[0])) +
        ' --hostname ' + QuotedArgument(Trim(NetworkPage.Values[1])) +
        ' --certificate-mode ' + SelectedCertificateMode;
      if SelectedCertificateMode = 'provided' then
        Arguments := Arguments + ' --certificate ' + QuotedArgument(CertificatePage.Values[0]) +
          ' --private-key ' + QuotedArgument(CertificatePage.Values[1]);
    end;
  end;
  Result := Exec(Executable, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if LoadStringFromFile(ReportPath, Contents) then MessageText := String(Contents)
  else MessageText := 'The service helper could not run. Inspect the setup log and Windows application policy.';
  if Result then Result := ExitCode = 0;
  Log(Action + ': ' + MessageText);
end;

function InitializeSetup: Boolean;
begin
  Result := PortableMode or IsAdminInstallMode;
  if not Result then MsgBox('Service installation requires Windows administrator approval. Use /PORTABLE=1 /CURRENTUSER only for extraction without Windows integration.', mbError, MB_OK);
end;

procedure InitializeWizard;
var ExistingPort, CommandVersion: Cardinal; DefaultPort, AccessParameter, CertificateModeParameter: String;
begin
  ServiceStopped := False;
  ServiceInstalled := False;
  DefaultPort := '5090';
  if not PortableMode and RegQueryDWordValue(HKLM64, 'SOFTWARE\SparkStudio\Installer', 'Port', ExistingPort) then
    DefaultPort := IntToStr(ExistingPort);
  HasManagedInstallation := not PortableMode and RegQueryDWordValue(HKLM64, 'SOFTWARE\SparkStudio\Installer', 'CommandVersion', CommandVersion) and (CommandVersion = 2);
  AccessPage := CreateInputOptionPage(wpSelectDir, 'Gateway access', 'Choose who can connect to this gateway',
    'Local access is always retained for setup, recovery and service health checks. Network access adds a separate encrypted listener. No firewall rule or certificate trust is installed automatically.', True, False);
  AccessPage.Add('Local only — HTTP on 127.0.0.1');
  AccessPage.Add('Network access — HTTPS on all IPv4 interfaces (0.0.0.0)');
  if HasManagedInstallation then AccessPage.Add('Keep existing listener settings (recommended for upgrades)');
  AccessPage.SelectedValueIndex := 0;
  if HasManagedInstallation then AccessPage.SelectedValueIndex := 2;
  AccessParameter := Lowercase(Trim(ExpandConstant('{param:ACCESS|}')));
  if (AccessParameter <> '') and (AccessParameter <> 'local') and (AccessParameter <> 'network') and (AccessParameter <> 'keep') then
    RaiseException('Invalid /ACCESS value. Use local, network or keep.');
  if (AccessParameter = 'keep') and not HasManagedInstallation then
    RaiseException('/ACCESS=keep requires an existing managed-listener installation. Choose local or network explicitly for a legacy installation.');
  if AccessParameter = 'network' then AccessPage.SelectedValueIndex := 1
  else if AccessParameter = 'local' then AccessPage.SelectedValueIndex := 0
  else if (AccessParameter = 'keep') and HasManagedInstallation then AccessPage.SelectedValueIndex := 2;
  PortPage := CreateInputQueryPage(AccessPage.ID, 'Local management connection', 'Choose the local management port',
    'HTTP listens only on 127.0.0.1. Use this address on the gateway computer for initial administrator setup and recovery. The security code is in ' + ExpandConstant('{commonappdata}\SparkStudio\security\setup-code.txt') + '.' + #13#10 + #13#10 +
    'Gateway data is retained in ' + ExpandConstant('{commonappdata}\SparkStudio') + ' during upgrades and uninstall.');
  PortPage.Add('Local management port:', False);
  PortPage.Values[0] := ExpandConstant('{param:PORT|' + DefaultPort + '}');
  NetworkPage := CreateInputQueryPage(PortPage.ID, 'Network HTTPS connection', 'Choose the HTTPS port and DNS name or IPv4 address',
    'Use this gateway''s stable IPv4 address without needing DNS, or a DNS name that resolves to it. Setup can generate a self-signed certificate for exactly this name or address, or you can supply one from your organization. Use a fixed IP or DHCP reservation for IP access.');
  NetworkPage.Add('HTTPS port (different from the local management port):', False);
  NetworkPage.Add('DNS name or IPv4 address (for example 192.168.1.50):', False);
  NetworkPage.Values[0] := ExpandConstant('{param:HTTPSPORT|5443}');
  NetworkPage.Values[1] := ExpandConstant('{param:HOSTNAME|}');
  CertificateModePage := CreateInputOptionPage(NetworkPage.ID, 'HTTPS certificate', 'Choose how to secure the network connection',
    'Generate a certificate when you have no certificate or private key. Browsers will warn until you trust the generated public certificate on each operator computer. Setup creates a protected private key and a public certificate with trust instructions; it does not install trust or open firewall ports automatically.', True, False);
  CertificateModePage.Add('Generate a self-signed certificate (no files needed)');
  CertificateModePage.Add('Use an existing certificate and private key');
  CertificateModePage.SelectedValueIndex := 0;
  CertificatePage := CreateInputFilePage(CertificateModePage.ID, 'Existing HTTPS certificate', 'Select the certificate and its matching private key',
    'Select a currently valid PEM server certificate (include intermediate certificates after the leaf) and its unencrypted PEM private key. Setup copies them into a protected gateway folder. Operator computers must trust the issuing CA. Configure an inbound Windows firewall rule for the HTTPS port on the intended network profile separately.');
  CertificatePage.Add('PEM certificate / certificate chain:', 'PEM certificate|*.pem;*.crt;*.cer|All files|*.*', '.pem');
  CertificatePage.Add('Matching unencrypted PEM private key:', 'PEM private key|*.pem;*.key|All files|*.*', '.pem');
  CertificatePage.Values[0] := ExpandConstant('{param:CERTIFICATE|}');
  CertificatePage.Values[1] := ExpandConstant('{param:PRIVATEKEY|}');
  CertificateModeParameter := Lowercase(Trim(ExpandConstant('{param:CERTIFICATEMODE|}')));
  if (CertificateModeParameter <> '') and (CertificateModeParameter <> 'self-signed') and (CertificateModeParameter <> 'provided') then
    RaiseException('Invalid /CERTIFICATEMODE value. Use self-signed or provided.');
  if (CertificateModeParameter = 'self-signed') and ((CertificatePage.Values[0] <> '') or (CertificatePage.Values[1] <> '')) then
    RaiseException('Do not combine /CERTIFICATEMODE=self-signed with /CERTIFICATE or /PRIVATEKEY. Choose provided to import existing files.');
  if (CertificateModeParameter = 'provided') or ((CertificateModeParameter = '') and ((CertificatePage.Values[0] <> '') or (CertificatePage.Values[1] <> ''))) then
    CertificateModePage.SelectedValueIndex := 1;
  if PortableMode then begin
    WizardForm.WelcomeLabel2.Caption := 'This mode only extracts the offline application. No service, registry registration, shortcuts or automatic application launch will be created.';
  end else begin
    ExtractTemporaryFile('SparkStudio.ServiceHelper.exe');
    HelperPath := ExpandConstant('{tmp}\SparkStudio.ServiceHelper.exe');
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PortableMode and ((PageID = AccessPage.ID) or (PageID = PortPage.ID) or (PageID = NetworkPage.ID) or (PageID = CertificateModePage.ID) or (PageID = CertificatePage.ID) or (PageID = wpSelectTasks)))
    or ((SelectedAccess <> 'network') and ((PageID = NetworkPage.ID) or (PageID = CertificateModePage.ID) or (PageID = CertificatePage.ID)))
    or ((PageID = CertificatePage.ID) and (SelectedCertificateMode = 'self-signed'));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var MessageText: String;
begin
  Result := True;
  if (CurPageID = PortPage.ID) and not PortableMode then begin
    if not ValidPort then begin
      MsgBox('Enter a port between 1024 and 65535, without spaces or leading zeros.', mbError, MB_OK);
      Result := False;
    end else if SelectedAccess <> 'network' then begin
      if not RunHelper('preflight', ExpandConstant('{app}'), HelperPath, MessageText) then begin
        MsgBox(MessageText, mbError, MB_OK);
        Result := False;
      end;
    end;
  end;
  if ((CurPageID = CertificatePage.ID) or ((CurPageID = CertificateModePage.ID) and (SelectedCertificateMode = 'self-signed'))) and not PortableMode then
    if not RunHelper('preflight', ExpandConstant('{app}'), HelperPath, MessageText) then begin
      MsgBox(MessageText, mbError, MB_OK); Result := False;
    end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var MessageText: String;
begin
  Result := '';
  if PortableMode then Exit;
  if not ValidPort then begin Result := 'The requested port must be an integer from 1024 to 65535.'; Exit; end;
  if not RunHelper('prepare', ExpandConstant('{app}'), HelperPath, MessageText) then begin Result := MessageText; Exit; end;
  ServiceStopped := ServiceStopped or (Trim(MessageText) = 'stopped');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var MessageText: String;
begin
  if (CurStep = ssPostInstall) and not PortableMode then begin
    if not RunHelper('install', ExpandConstant('{app}'), HelperPath, MessageText) then RaiseException(MessageText);
    ServiceInstalled := True;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and ServiceInstalled and (SelectedAccess = 'network') and (SelectedCertificateMode = 'self-signed') then
    WizardForm.FinishedLabel.Caption := 'HTTPS: https://' + Trim(NetworkPage.Values[1]) + ':' + Trim(NetworkPage.Values[0]) + '/' + #13#10 + #13#10 +
      'Trust this public certificate on each operator computer to avoid browser warnings. Copy it using administrator access:' + #13#10 +
      ExpandConstant('{commonappdata}\SparkStudio\certificates\deployment\gateway-public.cer') + #13#10 + #13#10 +
      'Read gateway-trust.txt beside it. Never share the private key.';
end;

procedure DeinitializeSetup;
var MessageText: String;
begin
  if ServiceStopped and not ServiceInstalled and (HelperPath <> '') then
    if not RunHelper('resume', ExpandConstant('{app}'), HelperPath, MessageText) then
      Log('Could not resume the previously owned service: ' + MessageText);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var MessageText, ReportPath, Arguments: String; ExitCode: Integer; Contents: AnsiString;
  Succeeded: Boolean;
begin
  { This event occurs after uninstall confirmation and before deleting files. }
  if CurUninstallStep <> usUninstall then Exit;
  ReportPath := ExpandConstant('{tmp}\sparkstudio-uninstall-result.txt');
  Arguments := '--action remove --install-dir "' + ExpandConstant('{app}') + '" --report "' + ReportPath + '"';
  Succeeded := Exec(ExpandConstant('{app}\SparkStudio.ServiceHelper.exe'), Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if Succeeded then Succeeded := ExitCode = 0;
  if not Succeeded then begin
    if LoadStringFromFile(ReportPath, Contents) then MessageText := String(Contents)
    else MessageText := 'Service cleanup failed. Program files and data have been kept. Inspect the Windows service before retrying.';
    RaiseException(MessageText);
  end;
end;
