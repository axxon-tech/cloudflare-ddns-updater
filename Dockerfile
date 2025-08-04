FROM  node:22

WORKDIR /app

COPY package.json /app

RUN npm install

VOLUME [ "/app/config.json" ]

COPY . /app

CMD ["npm", "start"]
