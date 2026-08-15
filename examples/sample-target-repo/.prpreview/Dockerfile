# Example .prpreview/Dockerfile — this file lives IN THE TARGET REPO,
# not in prpreview itself. prpreview's LocalDockerProvider builds this
# file at the PR's commit SHA and runs the resulting container.
#
# Contract: the app must listen on port 3000 inside the container.
# prpreview injects PREVIEW=true and PR_NUMBER as env vars; it does NOT
# inject any production secrets — wire in your own test/sandbox
# credentials via your app's normal env-var loading if you need them.

FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build --if-present

EXPOSE 3000
CMD ["npm", "start"]
