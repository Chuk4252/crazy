param(
  [Parameter(Mandatory = $false)]
  [string]$GitHubToken = $env:GITHUB_TOKEN,

  [Parameter(Mandatory = $false)]
  [string]$RepoName = "Crazy-Downloader"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
  Write-Host "[Auth] Opening GitHub sign-in via Git Credential Manager (check your browser or sign-in window)..."
  $gcmInput = "protocol=https`nhost=github.com`n`n"
  $gcmOutput = $gcmInput | git credential-manager get
  foreach ($line in ($gcmOutput -split "`r?`n")) {
    if ($line -match "^password=(.+)$") {
      $GitHubToken = $Matches[1].Trim()
    }
  }
}

if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
  throw "GitHub sign-in was canceled or did not return an access token."
}

$headers = @{
  "Authorization" = "Bearer $GitHubToken"
  "Accept"        = "application/vnd.github+json"
  "User-Agent"    = "Crazy-Downloader-Publisher"
}

Write-Host "[1/4] Verifying GitHub account and token scopes..."
$userResp = Invoke-WebRequest -Uri "https://api.github.com/user" -Headers $headers -Method Get -UseBasicParsing
$scopes = [string]$userResp.Headers["X-OAuth-Scopes"]
$user = $userResp.Content | ConvertFrom-Json
$owner = $user.login
Write-Host "      Authenticated as : $owner"
Write-Host "      Token scopes     : $(if ($scopes) { $scopes } else { '(none)' })"

if ($scopes -notmatch "repo") {
  throw "This Personal Access Token has no 'repo' scope enabled. On https://github.com/settings/tokens, edit the token, check the 'repo' and 'workflow' boxes, click Update token, and run again."
}

Write-Host "[2/4] Creating repository '$RepoName' on GitHub..."
$repoBody = @{
  name        = $RepoName
  description = "Crazy Downloader 2.1.0 Public Website, Windows 10 and 11 build, and companion browser extension folder"
  private     = $false
  has_pages   = $true
} | ConvertTo-Json

try {
  $repo = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $repoBody -ContentType "application/json"
  Write-Host "      Created repository: $($repo.html_url)"
} catch {
  $checkUrl = "https://api.github.com/repos/$owner/$RepoName"
  try {
    $existing = Invoke-RestMethod -Uri $checkUrl -Headers $headers -Method Get
    Write-Host "      Repository already exists: $($existing.html_url)"
  } catch {
    throw "Could not create or access repository '$owner/$RepoName'. Verify token permissions."
  }
}

Write-Host "[3/4] Pushing website, Crazy Downloader 2.1.0.exe (Git LFS), and extensions folder to main..."
$remoteUrl = "https://${owner}:${GitHubToken}@github.com/${owner}/${RepoName}.git"
$existingRemote = git remote
if ($existingRemote -contains "origin") {
  git remote set-url origin $remoteUrl
} else {
  git remote add origin $remoteUrl
}

git push -u origin main --force
git remote set-url origin "https://github.com/${owner}/${RepoName}.git"

Write-Host "[4/4] Enabling GitHub Pages (GitHub Actions workflow deployment)..."
$pagesBody = @{
  build_type = "workflow"
  source     = @{
    branch = "main"
    path   = "/"
  }
} | ConvertTo-Json

try {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$RepoName/pages" -Headers $headers -Method Post -Body $pagesBody -ContentType "application/json" | Out-Null
} catch {
  try {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$RepoName/pages" -Headers $headers -Method Put -Body $pagesBody -ContentType "application/json" | Out-Null
  } catch {}
}

Write-Host ""
Write-Host "Published! Repository URL : https://github.com/$owner/$RepoName"
Write-Host "GitHub Pages URL          : https://$owner.github.io/$RepoName/"
