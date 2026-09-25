#ifndef BundleDir
  #error BundleDir must point to the packaged Ash-win32-x64 directory
#endif
#ifndef AppVersion
  #error AppVersion must match app-ts/package.json
#endif
#ifndef AppUserId
  #error AppUserId must match the Electron application ID
#endif
#ifndef IconPath
  #error IconPath must point to resources/win32/ash.ico
#endif

[Setup]
AppId={#AppUserId}
AppName=Ash
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Ash
DefaultGroupName=Ash
PrivilegesRequired=lowest
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

[Icons]
Name: "{autoprograms}\Ash"; Filename: "{app}\Ash.exe"; IconFilename: "{app}\Ash.exe"; AppUserModelID: "{#AppUserId}"
Name: "{autodesktop}\Ash"; Filename: "{app}\Ash.exe"; IconFilename: "{app}\Ash.exe"; AppUserModelID: "{#AppUserId}"; Tasks: desktopicon
