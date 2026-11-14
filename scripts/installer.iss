#define AppName "DOConstruct"
#define AppVersion "0.2.5"
#define Root AddBackslash(AddBackslash(SourcePath) + "..")
#define AppSource Root + "dist\win-unpacked"

[Setup]
AppId={{DBED5595-9D2A-4DB7-9BDD-76E2D9293047}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion=0.2.5.0
AppVerName={#AppName} {#AppVersion}
DefaultDirName={localappdata}\Programs\{#AppName}
UsePreviousAppDir=yes
DisableDirPage=auto
DefaultGroupName={#AppName}
UsePreviousGroup=yes
UsePreviousTasks=yes
UpdateUninstallLogAppName=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
WizardStyle=modern
WizardSizePercent=110
OutputDir={#Root}dist
OutputBaseFilename=DOConstruct-Setup-{#AppVersion}-x64
SetupIconFile={#Root}resources\icon.ico
UninstallDisplayIcon={app}\resources\icon.ico
Compression=lzma2/fast
SolidCompression=yes
LZMANumBlockThreads=2
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "chinesetraditional"; MessagesFile: "compiler:Languages\ChineseTraditional.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\DOConstruct.exe"; IconFilename: "{app}\resources\icon.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\DOConstruct.exe"; IconFilename: "{app}\resources\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\DOConstruct.exe"; Description: "Launch DOConstruct"; Flags: nowait postinstall skipifsilent
