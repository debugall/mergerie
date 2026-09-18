<#
.SYNOPSIS
  Installe ce qu'il faut pour la dictée vocale de Mergerie sous Windows (voir whisper.md) :
  le moteur whisper.cpp (whisper-server.exe + whisper-cli.exe), un modèle Whisper et le modèle
  de détection de voix Silero, dans le dossier de données de Mergerie.
  macOS et Linux ont leur propre script : scripts/install-whisper.sh.

.DESCRIPTION
  Tout est gratuit et local : whisper.cpp et les modèles sont sous licence MIT, rien ici
  n'appelle un service payant. Le binaire vient des zips de la dernière release GitHub de
  ggml-org/whisper.cpp (pas de compilation), les modèles de Hugging Face.

  Relançable sans risque : ce qui est déjà en place est gardé, un téléchargement interrompu
  reprend où il s'est arrêté (curl.exe, livré avec Windows 10+).

  Lancé par Mergerie (bouton « Installer » des réglages, whisper.md §6.5) : MERGERIE_JOB=1, ou
  simplement une sortie redirigée. Alors pas de barre de progression (une ligne toutes les 5 s),
  sortie en UTF-8, et une dernière ligne `MERGERIE_RESULT {…}` que le serveur lit pour remplir
  les réglages.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1
  # large-v3-turbo, CPU, dans data\models

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1 -Cuda -AddToPath
  # carte NVIDIA : prend la variante CUDA, et ajoute le dossier du binaire au PATH utilisateur

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1 -Model large-v3-turbo-q5_0
  # machine modeste : modèle quantifié de 574 Mo

.PARAMETER Model
  large-v3-turbo (défaut) | large-v3-turbo-q8_0 | large-v3-turbo-q5_0 | large-v3 | large-v3-q5_0 | …
.PARAMETER Dir
  Dossier de données (défaut : $env:MERGERIE_DATA_DIR, sinon <dépôt>\data).
.PARAMETER Cuda
  Prend le zip compilé avec CUDA (carte NVIDIA, pilote récent). Sinon : CPU pur.
.PARAMETER NoVad
  Ne pas télécharger le modèle Silero.
.PARAMETER AddToPath
  Ajoute <données>\whisper\bin au PATH de l'utilisateur (nouvelles fenêtres seulement).
.PARAMETER Force
  Retélécharge le binaire même s'il est déjà là.
#>
[CmdletBinding()]
param(
  [string]$Model = 'large-v3-turbo',
  [string]$Dir = '',
  [switch]$Cuda,
  [switch]$NoVad,
  [switch]$AddToPath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest est 10× plus lent avec la barre
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# Mode job : pas de barre de progression, UTF-8 (sinon les accents du journal arrivent cassés
# dans Node), et la ligne MERGERIE_RESULT à la fin.
$Job = ($env:MERGERIE_JOB -eq '1') -or [Console]::IsOutputRedirected
if ($Job) { try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {} }

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Dir) { $Dir = if ($env:MERGERIE_DATA_DIR) { $env:MERGERIE_DATA_DIR } else { Join-Path $Root 'data' } }
$ModelsDir   = Join-Path $Dir 'models'
$WhisperHome = Join-Path $Dir 'whisper'
$BinDir      = Join-Path $WhisperHome 'bin'
$ModelFile   = Join-Path $ModelsDir "ggml-$Model.bin"
$VadFile     = Join-Path $ModelsDir 'ggml-silero-v5.1.2.bin'
# ÉPINGLÉ, comme install-whisper.sh : une version, une révision des modèles, une empreinte par
# fichier. « latest » et « main » exécutaient ce que le dépôt distant servait ce jour-là.
$Tag         = 'v1.9.2'
$HfRev       = '5359861c739e955e79d9a303bcbc70fb988958b1'
$VadRev      = '9ffd54a1e1ee413ddf265af9913beaf518d1639b'
$ModelUrl    = "https://huggingface.co/ggerganov/whisper.cpp/resolve/$HfRev/ggml-$Model.bin"
$VadUrl      = "https://huggingface.co/ggml-org/whisper-vad/resolve/$VadRev/ggml-silero-v5.1.2.bin"
$Repo        = 'ggml-org/whisper.cpp'
$Empreintes  = @{
  'ggml-large-v3-turbo.bin'      = '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
  'ggml-large-v3-turbo-q8_0.bin' = '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1'
  'ggml-large-v3-turbo-q5_0.bin' = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  'ggml-large-v3.bin'            = '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'
  'ggml-large-v3-q5_0.bin'       = 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1'
  'ggml-medium.bin'              = '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'
  'ggml-small.bin'               = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
  'ggml-base.bin'                = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  'ggml-silero-v5.1.2.bin'       = '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
  'whisper-bin-x64.zip'          = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
  'whisper-cublas-12.4.0-bin-x64.zip' = '443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c'
}

function Say($t)  { Write-Host ''; Write-Host $t -ForegroundColor White }
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!!] $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host ''; Write-Host "  [x] $t" -ForegroundColor Red; exit 1 }
# Refuse (et efface) un fichier dont l'empreinte n'est pas celle attendue.
function VerifierSha($fichier) {
  $nom = Split-Path $fichier -Leaf
  $attendu = $Empreintes[$nom]
  if (-not $attendu) { Warn "$nom : aucune empreinte connue, fichier NON vérifié"; return }
  $recu = (Get-FileHash -Algorithm SHA256 -Path $fichier).Hash.ToLower()
  if ($recu -ne $attendu) { Remove-Item -Force $fichier; Die "$nom : empreinte inattendue ($recu) — fichier effacé, rien n'est installé" }
  Ok "$nom : empreinte sha256 vérifiée"
}

$known = 'large-v3-turbo','large-v3-turbo-q8_0','large-v3-turbo-q5_0','large-v3','large-v3-q5_0','medium','small','base'
if ($known -notcontains $Model) { Warn "modèle « $Model » hors de la liste connue : on tente quand même ggml-$Model.bin" }

# ---------- téléchargement avec reprise ----------
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
function Fetch($url, $dest) {
  if ($curl) {
    if ($Job) {
      # une ligne toutes les 5 s au lieu d'une barre : curl en arrière-plan, on regarde le fichier grossir
      $total = 0
      try { $h = & $curl.Source -sIL $url 2>$null | Out-String; if ($h -match '(?im)^content-length:\s*(\d+)\s*$') { $total = [int64]$Matches[1] } } catch {}
      $p = Start-Process -FilePath $curl.Source -ArgumentList @('-sSL','--fail','--retry','3','--retry-delay','2','-C','-','-o',"`"$dest`"","`"$url`"") -NoNewWindow -PassThru
      while (-not $p.HasExited) {
        Start-Sleep -Seconds 5
        if ($p.HasExited) { break }
        if (Test-Path $dest) {
          $mo = [math]::Round((Get-Item $dest).Length / 1MB)
          if ($total -gt 0) { Write-Host "  … $mo / $([math]::Round($total / 1MB)) Mo" } else { Write-Host "  … $mo Mo" }
        }
      }
      if ($p.ExitCode -ne 0) { & $curl.Source -sSL --fail --retry 3 -o $dest $url; if ($LASTEXITCODE -ne 0) { Die "téléchargement échoué : $url" } }
    } else {
      & $curl.Source -L --fail --retry 3 --retry-delay 2 -C - --progress-bar -o $dest $url
      if ($LASTEXITCODE -ne 0) { & $curl.Source -L --fail --retry 3 --progress-bar -o $dest $url }
      if ($LASTEXITCODE -ne 0) { Die "téléchargement échoué : $url" }
    }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }
}

# Un fichier ggml commence par la signature « lmgg » ; une page d'erreur HTML commence par « < ».
function Head($path, $n) {
  $fs = [IO.File]::OpenRead($path); try { $b = New-Object byte[] $n; $r = $fs.Read($b, 0, $n); return [Text.Encoding]::ASCII.GetString($b, 0, $r) } finally { $fs.Close() }
}
function IsGgml($path) { (Test-Path $path) -and ((Head $path 4) -eq 'lmgg') }
function Mo($path) { [math]::Round((Get-Item $path).Length / 1MB) }

# ---------- 1. le moteur ----------
Say '1/3  Moteur whisper.cpp'
$ServerBin = Join-Path $BinDir 'whisper-server.exe'
$CliBin    = Join-Path $BinDir 'whisper-cli.exe'

if ((Test-Path $ServerBin) -and -not $Force) {
  Ok "whisper-server.exe déjà là : $ServerBin (relancer avec -Force pour le remplacer)"
} else {
  # La release épinglée ; la variante CUDA est celle de cette release (cublas 12.4).
  $nomZip = if ($Cuda) { 'whisper-cublas-12.4.0-bin-x64.zip' } else { 'whisper-bin-x64.zip' }
  $rel = @{ tag_name = $Tag }
  $asset = @{ name = $nomZip; browser_download_url = "https://github.com/$Repo/releases/download/$Tag/$nomZip" }

  New-Item -ItemType Directory -Force -Path $WhisperHome | Out-Null
  $zip = Join-Path $WhisperHome $asset.name
  Write-Host "  téléchargement de $($asset.name) ($Tag) …"
  Fetch $asset.browser_download_url $zip
  VerifierSha $zip

  $tmp = Join-Path $WhisperHome '_extract'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $srv = Get-ChildItem -Path $tmp -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
  if (-not $srv) { Die "whisper-server.exe absent du zip $($asset.name) — son contenu : $((Get-ChildItem -Recurse $tmp -File | Select-Object -Expand Name) -join ', ')" }
  # tout ce qui accompagne le serveur (dll ggml/whisper, whisper-cli.exe) vit dans le même dossier
  if (Test-Path $BinDir) { Remove-Item -Recurse -Force $BinDir }
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Copy-Item -Path (Join-Path $srv.DirectoryName '*') -Destination $BinDir -Recurse -Force
  Remove-Item -Recurse -Force $tmp
  Remove-Item -Force $zip
  Ok "installé dans $BinDir ($($rel.tag_name))"
}

$help = & $ServerBin --help 2>&1 | Out-String
if ($help -notmatch 'usage') { Die "$ServerBin ne démarre pas (dll manquante ? pilote CUDA absent pour la variante -Cuda ?)`n$help" }
Ok 'whisper-server.exe répond'

# ---------- 2. les modèles ----------
Say "2/3  Modèles (dans $ModelsDir)"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

if ((IsGgml $ModelFile) -and ((Get-Item $ModelFile).Length -gt 10MB)) {
  Ok "ggml-$Model.bin déjà là ($(Mo $ModelFile) Mo)"
} else {
  Write-Host "  téléchargement de ggml-$Model.bin (large-v3-turbo ≈ 1,6 Go ; large-v3 ≈ 3,1 Go) …"
  Fetch $ModelUrl $ModelFile
  VerifierSha $ModelFile
  if (-not (IsGgml $ModelFile)) { Remove-Item -Force $ModelFile; Die 'le fichier reçu n''est pas un modèle ggml (nom de modèle inconnu sur Hugging Face ?)' }
  Ok "ggml-$Model.bin ($(Mo $ModelFile) Mo)"
}

if (-not $NoVad) {
  if ((Test-Path $VadFile) -and ((Get-Item $VadFile).Length -gt 200KB) -and ((Head $VadFile 1) -ne '<')) {
    Ok 'ggml-silero-v5.1.2.bin déjà là'
  } else {
    Write-Host '  téléchargement du modèle de détection de voix Silero …'
    Fetch $VadUrl $VadFile
    VerifierSha $VadFile
    if ((Head $VadFile 1) -eq '<') { Remove-Item -Force $VadFile; Die 'le fichier VAD reçu est une page HTML, pas un modèle' }
    Ok 'ggml-silero-v5.1.2.bin'
  }
}

# ---------- 3. le modèle se charge-t-il vraiment ? ----------
Say '3/3  Vérification'
$Backend = 'CPU'
if (Test-Path $CliBin) {
  $wav = Join-Path $env:TEMP 'mergerie-silence.wav'
  # 1 s de silence, 16 kHz mono 16 bits : en-tête WAV de 44 octets puis 32 000 octets à zéro.
  $data = 32000
  $bw = New-Object IO.BinaryWriter ([IO.File]::Create($wav))
  try {
    $bw.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $bw.Write([int32](36 + $data))
    $bw.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $bw.Write([int32]16)
    $bw.Write([int16]1); $bw.Write([int16]1); $bw.Write([int32]16000); $bw.Write([int32]32000); $bw.Write([int16]2); $bw.Write([int16]16)
    $bw.Write([Text.Encoding]::ASCII.GetBytes('data')); $bw.Write([int32]$data)
    $bw.Write((New-Object byte[] $data))
  } finally { $bw.Close() }

  $log = & $CliBin -m $ModelFile -f $wav -l fr -nt 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    if ($log -match 'cuda')   { $Backend = 'CUDA (GPU NVIDIA)' }
    if ($log -match 'vulkan') { $Backend = 'Vulkan (GPU)' }
    Ok "le modèle se charge ; accélération : $Backend"
    if ($log -match 'total time\s*=\s*([\d.]+ ms)') { Ok "1 s de silence traitée en $($Matches[1]) (chargement du modèle compris)" }
  } else {
    Warn 'whisper-cli.exe n''a pas réussi à charger le modèle :'
    Write-Host ($log -split "`n" | Select-Object -Last 15 | Out-String)
  }
  Remove-Item -Force $wav -ErrorAction SilentlyContinue
} else {
  Warn 'whisper-cli.exe absent du zip : vérification du chargement sautée'
}

# ---------- PATH ----------
$inPath = ($env:Path -split ';') -contains $BinDir
if ($AddToPath -and -not $inPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
  Ok "$BinDir ajouté au PATH utilisateur (ouvrir une nouvelle fenêtre pour le voir)"
  $inPath = $true
}

# ---------- récapitulatif ----------
Say 'Installé'
Write-Host "  moteur   : $ServerBin"
Write-Host "  modèle   : $ModelFile"
if (-not $NoVad) { Write-Host "  VAD      : $VadFile" }
Write-Host ''
Write-Host '  Réglages Mergerie › IA › Dictée vocale (cf. whisper.md §6.3) :'
Write-Host '    dictation_provider  = local'
Write-Host "    dictation_model     = $ModelFile"
if (-not $NoVad) { Write-Host "    dictation_vad_model = $VadFile" }
if ($inPath) { Write-Host '    dictation_command   = (vide : whisper-server est dans le PATH)' } else { Write-Host "    dictation_command   = $ServerBin" }
Write-Host ''
Write-Host '  Pour l''essayer à la main dès maintenant :'
$vadArgs = if ($NoVad) { '' } else { " --vad --vad-model `"$VadFile`"" }
Write-Host "    & `"$ServerBin`" -m `"$ModelFile`" --host 127.0.0.1 --port 8178 -l fr$vadArgs"
Write-Host '    curl.exe -s 127.0.0.1:8178/inference -F file=@mon-audio.wav -F response_format=text'

# Dernière ligne, pour Mergerie : ce qu'il faut écrire dans les réglages.
if ($Job) {
  $result = [ordered]@{ server = $ServerBin; model = $ModelFile; vad = $(if ($NoVad) { $null } else { $VadFile }); backend = $Backend; in_path = [bool]$inPath }
  Write-Output ('MERGERIE_RESULT ' + ($result | ConvertTo-Json -Compress))
}
