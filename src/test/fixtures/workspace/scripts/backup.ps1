<#
.SYNOPSIS
Backs up a folder. A param( in this comment must not count.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Target,

    [ValidateSet('daily', 'weekly')]
    [string]$Schedule = 'daily',

    [switch]$Force
)
Write-Output "backup $Target $Schedule $Force"
