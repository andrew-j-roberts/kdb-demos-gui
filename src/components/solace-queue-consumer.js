/**
 * solace-client.js
 * @author Andrew Roberts
 */

import solace from "solclientjs";

/**
 * A factory function that returns a solclientjs session wrapper.
 * If hostUrl or options are not provided, the client will attempt to
 * connect using Solace PubSub+ friendly defaults.
 * @param {object} options
 */
export function createSolaceClient({
  // assign defaults if the values aren't included in the provided object,
  url = "ws://localhost:80",
  vpnName = "default",
  userName = "default",
  password = "",
}) {
  /**
   * initialize solclientjs
   */
  let factoryProps = new solace.SolclientFactoryProperties();
  factoryProps.profile = solace.SolclientFactoryProfiles.version10;
  solace.SolclientFactory.init(factoryProps);

  /**
   * Private reference to the client connection objects
   */
  let session = null;

  /**
   * Private map between topic subscriptions and their associated handler callbacks.
   * Messages are dispatched to all topic subscriptions that match the incoming message's topic.
   * subscribe and unsubscribe modify this object.
   */
  let subscriptions = {};

  /**
   * TODO docs
   * queue consumer reference
   */
  let queueConsumer = {};

  /**
   * event handlers
   *
   * solclientjs exposes session lifecycle events, or callbacks related to the session with the broker.
   * The methods below are sensible defaults, and can be modified using the exposed setters.
   * Source documentation here:
   */

  let onUpNotice = (sessionEvent) => {
    logInfo(`Connected`);
  };

  let onConnectFailedError = (sessionEvent) => {
    logError(`Connect failed`);
  };

  let onDisconnected = (sessionEvent) => {
    logInfo(`Disconnected`);
  };

  // onMessage handler configured to dispatch incoming messages to
  // the associated handlers of all matching topic subscriptions.
  const onMessage = (message) => {
    const topic = message.getDestination().getName();
    for (const topicSubscription of Object.keys(subscriptions)) {
      if (topicMatchesTopicFilter(topicSubscription, topic)) {
        subscriptions[topicSubscription]?.handler(message);
      }
    }
  };

  /**
   * event handler setters
   */

  function setOnUpNotice(_onUpNotice) {
    onUpNotice = _onUpNotice;
  }

  function setOnConnectFailedError(_onConnectFailedError) {
    onConnectFailedError = _onConnectFailedError;
  }

  function setOnDisconnected(_onDisconnected) {
    onDisconnected = _onDisconnected;
  }

  /**
   * Overloaded solclientjs connect method.
   * Resolves with a solclientjs session wrapper object if UP_NOTICE ,
   * rejects if there is an error while connecting.
   *
   *  Solace docs:  https://docs.solace.com/API-Developer-Online-Ref-Documentation/js/solace.Session.html#connect
   */
  async function connect() {
    return new Promise((resolve, reject) => {
      // guard: if session is already connected, do not try to connect again.
      if (session !== null) {
        logError("Error from connect(), already connected.");
        reject();
      }
      // guard: check url protocol
      if (url.indexOf("ws") != 0) {
        reject("HostUrl must be the WebMessaging Endpoint that begins with either ws:// or wss://.");
      }
      // initialize session
      try {
        session = solace.SolclientFactory.createSession({
          url,
          vpnName,
          userName,
          password,
          connectRetries: 3,
          publisherProperties: {
            acknowledgeMode: solace.MessagePublisherAcknowledgeMode.PER_MESSAGE,
          },
        });
      } catch (error) {
        logError(error);
        reject();
      }

      /**
       * configure session event listeners
       */

      // UP_NOTICE fires when the session is connected
      session.on(solace.SessionEventCode.UP_NOTICE, (sessionEvent) => {
        onUpNotice();
        resolve({
          // extend base session object w/ overloaded methods and utils
          disconnect,
          subscribe,
          unsubscribe,
          logInfo,
          logError,
        });
      });

      // CONNECT_FAILED_ERROR fires on connection failure
      session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (sessionEvent) => {
        onConnectFailedError(sessionEvent);
        reject();
      });

      // DISCONNECTED fires if the session is disconnected
      session.on(solace.SessionEventCode.DISCONNECTED, (sessionEvent) => {
        onDisconnected();
        if (session !== null) {
          session.dispose();
          //subscribed = false;
          session = null;
        }
      });

      // ACKNOWLEDGED MESSAGE fires when the broker sends this session a message received receipt
      session.on(solace.SessionEventCode.ACKNOWLEDGED_MESSAGE, (sessionEvent) => {
        logError("Delivery of message with correlation key = " + sessionEvent.correlationKey + " confirmed.");
      });

      // REJECTED_MESSAGE fires if the broker sends this session a rejected message receipt
      session.on(solace.SessionEventCode.REJECTED_MESSAGE_ERROR, (sessionEvent) => {
        logError("Delivery of message with correlation key = " + sessionEvent.correlationKey + " rejected, info: " + sessionEvent.infoStr);
      });

      // SUBSCRIPTION ERROR fires if there's been an error while subscribing on a topic
      session.on(solace.SessionEventCode.SUBSCRIPTION_ERROR, (sessionEvent) => {
        logError(`Cannot subscribe to topic "${sessionEvent.correlationKey}"`);
        // remove subscription
        delete subscription[sessionEvent.correlationKey];
      });

      // SUBSCRIPTION_OK fires when a subscription was succesfully applied/removed from the broker
      session.on(solace.SessionEventCode.SUBSCRIPTION_OK, (sessionEvent) => {});

      // MESSAGE fires when this session receives a message
      session.on(solace.SessionEventCode.MESSAGE, onMessage);

      // connect the session
      try {
        session.connect();
      } catch (error) {
        logErro(error);
      }
    });
  }

  function disconnect() {
    if (session !== null) {
      try {
        session.disconnect();
      } catch (error) {
        logError(error);
      }
    }
  }

  /**
   * Overloaded solclientjs subscribe method.
   * Extends default subscribe behavior by accepting a handler argument
   * that is called with any incoming messages that match the topic subscription.
   * https://docs.solace.com/API-Developer-Online-Ref-Documentation/js/solace.Session.html#subscribe
   * @param {string} topic
   * @param {any} handler
   */
  function subscribe(topic, handler) {
    // Check if the session has been established
    if (!session) {
      logError("Error from subscribe(), session not connected.");
      return;
    }
    // Check if the subscription already exists
    if (subscriptions[topic]) {
      logError(`Error from subscribe(), already subscribed to "${topic}"`);
      return;
    }
    // associate event handler with topic filter on client
    subscriptions[topic] = { handler, isSubscribed: false };
    // subscribe session to topic
    try {
      session.subscribe(
        solace.SolclientFactory.createTopicDestination(topic),
        true, // generate confirmation when subscription is added successfully
        topic, // use topic name as correlation key
        10000 // 10 seconds timeout for this operation
      );
    } catch (error) {
      logError(error);
    }
  }

  /**
   * @param {string} topic
   */
  function unsubscribe(topic) {
    // guard: do not try to unsubscribe if session has not yet been connected
    if (!session) {
      logError(`Error unsubscribing, session is not connected`);
      return;
    }
    // remove event handler
    delete subscriptions[topic];
    // unsubscribe session from topic filter
    session.unsubscribe(solace.SolclientFactory.createTopicDestination(topic), true, topic);
  }

  /**
   * info level logger
   * @param {string} message
   */
  function logInfo(message) {
    const log = {
      userName,
      time: new Date().toISOString(),
      msg: message,
    };
    console.log(JSON.stringify(log));
  }

  /**
   * error level logger
   * @param {string} message
   */
  function logError(error) {
    const errorLog = {
      userName,
      time: new Date().toISOString(),
      error: error,
    };
    console.error(JSON.stringify(errorLog));
  }

  /**
   * This factory function returns an object that only exposes methods to configure and connect the client.
   * Methods to add subscriptions (and all others) are exposed in the client the connect method resolves with.
   */
  return {
    connect,
    setOnUpNotice,
    setOnConnectFailedError,
    setOnDisconnected,
    logInfo,
    logError,
  };
}
