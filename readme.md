# Grafana Auth Proxy POC

Exploring the possibility of using the Auth Proxy setup in Grafana to sort of "intercept" requests and sync team membership.

## First Time Setup

To get the service account token that the `team-sync` app will need we have to do a little first-time setup here to solve the chicken/egg problem.

```sh
# Start just Grafana directly first with login enabled
docker compose run -e GF_AUTH_DISABLE_LOGIN_FORM=false -e GF_AUTH_PROXY_ENABLED=false -p 3000:3000 grafana

# Hit localhost:3000, log in as admin/admin
# Go to Administration → Service Accounts → Add service account
# Give it Admin role, create a token, copy it

# Put it in .env
echo "GRAFANA_SA_TOKEN=glsa_xxxx" > .env

# Now bring everything up
docker compose up
```