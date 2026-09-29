; SparkStudio preview installer. Compile with tools/build-installer.ps1.
#ifndef PayloadDir
  #error PayloadDir must point to the verified offline package stage.
#endif
#ifndef OutputFolder
  #error OutputFolder is required.
#endif
#ifndef AppVersion
  #define AppVersion "0.2.0-preview.5"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.2.0.5"
#endif

[Setup]
AppId={{C85DA4EA-0382-4B12-943A-CE73A1772FD8}
AppName=SparkStudio
AppVersion={#AppVersion}
AppVerName=SparkStudio {#AppVersion}
AppPublisher=SparkStudio
AppComments=Unsigned internal preview. Loopback gateway with an offline Python runtime.
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
  PortPage: TInputQueryWizardPage;
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
  Result := (Port >= 1) and (Port <= 65535) and (IntToStr(Port) = SelectedPort);
end;

function RunHelper(Action, DirectoryName, Executable: String; var MessageText: String): Boolean;
var ExitCode: Integer; ReportPath, Arguments: String; Contents: AnsiString;
begin
  ReportPath := ExpandConstant('{tmp}\sparkstudio-service-result.txt');
  DeleteFile(ReportPath);
  Arguments := '--action ' + Action + ' --install-dir "' + DirectoryName +
    '" --port ' + SelectedPort + ' --report "' + ReportPath + '"';
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
var ExistingPort: Cardinal; DefaultPort: String;
begin
  ServiceStopped := False;
  ServiceInstalled := False;
  DefaultPort := '5090';
  if not PortableMode and RegQueryDWordValue(HKLM64, 'SOFTWARE\SparkStudio\Installer', 'Port', ExistingPort) then
    DefaultPort := IntToStr(ExistingPort);
  PortPage := CreateInputQueryPage(wpSelectDir, 'Gateway connection', 'Choose the local gateway port',
    'The service listens only on 127.0.0.1. If a development gateway already uses 5090, choose another port such as 5092. Existing applications will not be stopped.' + #13#10 + #13#10 +
    'Gateway data is kept in ' + ExpandConstant('{commonappdata}\SparkStudio') + ' and retained during upgrades and uninstall.');
  PortPage.Add('Local port:', False);
  PortPage.Values[0] := ExpandConstant('{param:PORT|' + DefaultPort + '}');
  if PortableMode then begin
    WizardForm.WelcomeLabel2.Caption := 'This mode only extracts the offline application. No service, registry registration, shortcuts or automatic application launch will be created.';
  end else begin
    ExtractTemporaryFile('SparkStudio.ServiceHelper.exe');
    HelperPath := ExpandConstant('{tmp}\SparkStudio.ServiceHelper.exe');
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := PortableMode and ((PageID = PortPage.ID) or (PageID = wpSelectTasks));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var MessageText: String;
begin
  Result := True;
  if (CurPageID = PortPage.ID) and not PortableMode then begin
    if not ValidPort then begin
      MsgBox('Enter a port between 1 and 65535, without spaces or leading zeros.', mbError, MB_OK);
      Result := False;
    end else if not RunHelper('preflight', ExpandConstant('{app}'), HelperPath, MessageText) then begin
      MsgBox(MessageText, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var MessageText: String;
begin
  Result := '';
  if PortableMode then Exit;
  if not ValidPort then begin Result := 'The requested port must be an integer from 1 to 65535.'; Exit; end;
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
