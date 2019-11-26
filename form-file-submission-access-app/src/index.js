require('dotenv').config({ path: '.env' })

const url = require('url')
const _ = require('lodash')
const path = require('path')
const Hubspot = require('hubspot')
const express = require('express')
const storage = require('node-persist')
const bodyParser = require('body-parser')
const oauthController = require('./js/oauth-controller')
const contactsController = require('./js/contacts-controller')
const webhooksController = require('./js/webhooks-controller')
const webSocketController = require('./js/websocket-controller')
const setupSampleMiddleware = require('./js/setup-sample-middleware')

const PORT = 3000
const TOKENS_ITEM = 'tokens'
const STORAGE_PATH = '../storage'
const CLIENT_ID = process.env.HUBSPOT_CLIENT_ID
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET

const HUBSPOT_AUTH_CONFIG = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
}

let hubspot
let tokens = {}
let tokensInitialized = false

const updateTokens = async (newTokens) => {
  console.log('updating tokens', newTokens)
  tokens = _.extend(tokens, newTokens)
  tokens.updated_at = Date.now()
  await storage.setItem(TOKENS_ITEM, tokens)
}

const checkEnv = (req, res, next) => {
  if (_.startsWith(req.url, '/error')) return next()

  if (_.isNil(CLIENT_ID)) return res.redirect('/error?msg=Please set HUBSPOT_CLIENT_ID env variable to proceed')
  if (_.isNil(CLIENT_SECRET)) return res.redirect('/error?msg=Please set HUBSPOT_CLIENT_SECRET env variable to proceed')
  next()
}

const getHostUrl = (req) => {
  return url.format({
    protocol: 'https',
    hostname: req.get('host'),
  })
}

const isTokenExpired = () => {
  return Date.now() >= tokens.updated_at + tokens.expires_in * 1000
}

const setupHubspot = async (req, res, next) => {
  if (_.startsWith(req.url, '/error')) return next()
  if (_.startsWith(req.url, '/login')) return next()

  if (tokensInitialized && hubspot && !isTokenExpired()) {
    req.hubspot = hubspot
    next()
    return
  }

  const refreshToken = _.get(tokens, 'refresh_token')

  if (_.isNil(hubspot)) {
    const redirectUri = `${getHostUrl(req)}/auth/oauth-callback`
    console.log('Creating HubSpot api wrapper instance')
    hubspot = new Hubspot(_.extend({}, HUBSPOT_AUTH_CONFIG, { redirectUri, refreshToken }))
  }
  req.hubspot = hubspot

  if (!tokensInitialized && !_.isNil(refreshToken)) {
    console.log('Need to initialized tokens!')

    if (isTokenExpired()) {
      console.log('HubSpot: need to refresh token')
      const hubspotTokens = await req.hubspot.refreshAccessToken()
      await updateTokens(hubspotTokens)
      console.log('Updated tokens', tokens)
    } else {
      console.log('HubSpot: set access token')
      req.hubspot.setAccessToken(tokens.access_token)
    }

    tokensInitialized = true

    console.log('Tokens initialized')
  } else if (!_.startsWith(req.url, '/auth')) {
    console.log('Not initialized tokens!')
    return res.redirect('/login')
  }

  next()
}

const app = express()

app.use(express.static('public'))
app.set('view engine', 'pug')
app.set('views', path.join(__dirname, 'views'))

app.use(
  bodyParser.urlencoded({
    limit: '50mb',
    extended: true,
  })
)

app.use(
  bodyParser.json({
    limit: '50mb',
    extended: true,
    verify: webhooksController.getWebhookVerification(),
  })
)

app.use((req, res, next) => {
  console.log(req.method, req.url)
  next()
})

app.use(checkEnv)
app.use(setupHubspot)
app.use(setupSampleMiddleware)

app.get('/', (req, res) => {
  res.redirect('/contacts')
})

app.get('/login', async (req, res) => {
  if (tokensInitialized) return res.redirect('/')
  res.render('login')
})

app.use('/auth', oauthController.getRouter(updateTokens))
app.use('/contacts', contactsController.getRouter())
app.use('/webhooks', webhooksController.getRouter())

app.get('/error', (req, res) => {
  res.render('error', { error: req.query.msg })
})

app.use((error, req, res, next) => {
  res.render('error', { error: error.message })
})

try {
  storage
    .init({
      dir: STORAGE_PATH,
    })
    .then(() => storage.getItem(TOKENS_ITEM))
    .then((storageTokens) => {
      return (tokens = storageTokens)
    })
    .catch((e) => console.error(e))

  const server = app.listen(PORT, () => {
    console.log(`Listening on port : ${PORT}`)
  })

  webSocketController.init(server)
  process.on('SIGTERM', async () => {
    server.close(() => {
      console.log('Process terminated')
    })
  })
} catch (e) {
  console.log('Error during app start. ', e)
}
