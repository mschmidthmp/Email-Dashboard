name: Refresh HubSpot Email Stats

on:
  schedule:
    - cron: '0 11 * * *'
  workflow_dispatch:

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

permissions:
  contents: write

jobs:
  refresh-data:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Debug secret presence
        run: |
          if [ -z "$HUBSPOT_TOKEN" ]; then
            echo "ERROR: HUBSPOT_TOKEN is empty. Check the secret is added to THIS repo (Email-Dashboard) under Settings > Secrets and variables > Actions."
            exit 1
          else
            echo "Token is present (length: ${#HUBSPOT_TOKEN} chars)"
          fi
        env:
          HUBSPOT_TOKEN: ${{ secrets.HUBSPOT_TOKEN }}

      - name: Install axios
        run: npm install axios

      - name: Fetch HubSpot marketing email stats
        env:
          HUBSPOT_TOKEN: ${{ secrets.HUBSPOT_TOKEN }}
        run: node fetch-hs-stats.js

      - name: Commit and push updated stats
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add email_stats.json
          git diff --staged --quiet && echo "No changes to commit" || \
            git commit -m "chore: auto-update HubSpot email stats $(date -u '+%Y-%m-%d %H:%M UTC')"
          git push
