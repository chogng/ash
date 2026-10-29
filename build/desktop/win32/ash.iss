#ifndef BundleDir
  #error BundleDir must point to the packaged Ash-win32-x64 directory
#endif
#ifndef AppVersion
  #error AppVersion must match package.json
#endif
#ifndef AppUserId
  #error AppUserId must match the Electron application ID
#endif
#ifndef IconPath
  #error IconPath must point to resources/win32/ash.ico
#endif
#ifndef AppName
  #define AppName "Ash"
#endif

[Setup]
AppId={#AppUserId}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
RestartApplications=no
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=AshSetup-{#AppVersion}-win32-x64
SetupIconFile={#IconPath}
UninstallDisplayIcon={app}\Ash.exe
Compression=lzma2
SolidCompression=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BundleDir}\resources\bin\ash-app-server-daemon.exe"; DestName: "ash-install-maintenance.exe"; Flags: dontcopy
Source: "{#BundleDir}\resources\installation-files.json"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\Ash.exe"; IconFilename: "{app}\Ash.exe"; AppUserModelID: "{#AppUserId}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Ash.exe"; IconFilename: "{app}\Ash.exe"; AppUserModelID: "{#AppUserId}"; Tasks: desktopicon

[Run]
Filename: "{app}\Ash.exe"; Flags: nowait postinstall skipifsilent; Description: "{code:LaunchDescription}"
Filename: "{app}\Ash.exe"; Flags: nowait skipifnotsilent; Check: ShouldRestart

[CustomMessages]
StartAsh=Start Ash
zhStartAsh=启动 Ash
RemoveData=Also remove Ash settings, accounts, history and caches?%n%nYes: remove exclusively owned Ash data.%nNo: keep user data (default).%nCancel: cancel uninstallation.%n%nWorktrees, shared components and files without confirmed ownership are always preserved.
zhRemoveData=是否同时清除 Ash 设置、账户、历史记录和缓存？%n%n是：清除由此安装独占的 Ash 数据。%n否：保留用户数据（默认）。%n取消：取消卸载。%n%n工作树、共享组件和无法确认归属的文件始终保留。
CleanupFailed=Ash cleanup could not complete. Close Ash and retry. System services and firewall rules require running this uninstaller as administrator under the same Windows account. See the removal report in %1.
zhCleanupFailed=Ash 清理未完成。请关闭 Ash 后重试。清理系统服务和防火墙规则需要使用同一 Windows 账户以管理员身份运行卸载程序。卸载报告位于 %1。
InstallCleanupFailed=Ash could not prepare the installation. Close Ash and retry.
zhInstallCleanupFailed=Ash 无法准备安装。请关闭 Ash 后重试。
InvalidDataMode=ASHDATAMODE must be keep-data or purge.
zhInvalidDataMode=ASHDATAMODE 必须为 keep-data 或 purge。

[Code]
var
  RemovalMode: String;
  MaintenancePath: String;

function InstallationMessage(Name: String): String;
begin
  if ((GetUILanguage and $3FF) = $04) or (ExpandConstant('{param:ASHLANG|}') = 'zh') then
    Result := CustomMessage('zh' + Name)
  else
    Result := CustomMessage(Name);
end;

function RunMaintenance(Executable, Operation, Extra: String): Boolean;
var
  ExitCode: Integer;
begin
  Result := Exec(Executable, 'installation ' + Operation + ' --product desktop --root "' + ExpandConstant('{app}') + '" ' + Extra,
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if Result then Result := ExitCode = 0;
end;

function LaunchDescription(Param: String): String;
begin
  Result := InstallationMessage('StartAsh');
end;

function ShouldRestart: Boolean;
begin
  Result := ExpandConstant('{param:ASHRESTART|}') = 'yes';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ExtractTemporaryFile('ash-install-maintenance.exe');
  ExtractTemporaryFile('installation-files.json');
  if not RunMaintenance(ExpandConstant('{tmp}\ash-install-maintenance.exe'), 'prepare-upgrade',
      '--incoming "' + ExpandConstant('{tmp}\installation-files.json') + '"') then
    Result := InstallationMessage('InstallCleanupFailed')
  else
    Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if not RunMaintenance(ExpandConstant('{app}\resources\bin\ash-app-server-daemon.exe'), 'register', '') then
      RaiseException(InstallationMessage('InstallCleanupFailed'));
end;

function InitializeUninstall: Boolean;
var
  Choice: Integer;
begin
  Result := False;
  RemovalMode := ExpandConstant('{param:ASHDATAMODE|keep-data}');
  if (RemovalMode <> 'keep-data') and (RemovalMode <> 'purge') then begin
    SuppressibleMsgBox(InstallationMessage('InvalidDataMode'), mbError, MB_OK, IDOK);
    exit;
  end;
  if not UninstallSilent then begin
    Choice := MsgBox(InstallationMessage('RemoveData'), mbConfirmation, MB_YESNOCANCEL or MB_DEFBUTTON2);
    if Choice = IDCANCEL then exit;
    if Choice = IDYES then RemovalMode := 'purge' else RemovalMode := 'keep-data';
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    MaintenancePath := ExpandConstant('{tmp}\ash-install-maintenance.exe');
    if not FileCopy(ExpandConstant('{app}\resources\bin\ash-app-server-daemon.exe'), MaintenancePath, False) then
      RaiseException(InstallationMessage('InstallCleanupFailed'));
    if not RunMaintenance(MaintenancePath, 'prepare-uninstall', '--mode ' + RemovalMode) then
      RaiseException(FmtMessage(InstallationMessage('CleanupFailed'), [ExpandConstant('{localappdata}\Ash\installation-registry')]));
  end;
  if CurUninstallStep = usPostUninstall then
    if not RunMaintenance(MaintenancePath, 'finish-uninstall', '') then
      RaiseException(FmtMessage(InstallationMessage('CleanupFailed'), [ExpandConstant('{localappdata}\Ash\installation-registry')]));
end;
