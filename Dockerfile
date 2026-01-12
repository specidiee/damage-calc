FROM node:20-alpine

WORKDIR /usr/src/app/calc
COPY calc/package*.json ./
RUN npm install

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

COPY . .
RUN node build

EXPOSE 3000
CMD [ "node", "server.js" ]
