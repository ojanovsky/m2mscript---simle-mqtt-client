/**
 * Created by oja on 7/12/16.
 */
var sys = require('system');
var Tcpip = require('tcpipssl');


sys.sleep(10000);




/**
 * This is simple MQTT client which provides:
 *  - connect with or without name and password
 *  - subscribe an topic - one topic per one subscribe command
 *  - publish an message - one message per one publish command
 *
 * @constructor
 */
var MQTT_CLIENT = function () {

    var STATE_COMMAND_UNKNOWN = -1;
    var STATE_COMMAND = 0;
    var STATE_REMAINH = 1;
    var STATE_REMAINL = 2;
    var STATE_CONNACK_FLAG = 3;
    var STATE_CONNACK_RCODE = 4;
    var STATE_SUBACK_PACKETID = 5;
    var STATE_SUBACK_RCODE = 6;
    var STATE_PUBLISH_TOPLEN = 7;
    var STATE_PUBLISH_TOPIC = 8;
    var STATE_PUBLISH_MSG = 9;
    var STATE_PING_RESP = 10;


    var COMMAND_CONNACK = 32;
    var COMMAND_SUBSCRIBE = 0x82;
    var COMMAND_SUBACK = 0x90;
    var COMMAND_PUBLISH = 0x30;
    var COMMAND_PING_RESPONSE = 0xD0;

    var that = this;


    that._internal_state = 0;
    that._bytecounter = 0;
    that._actual_command = 0;
    that._remainLength = 0;
    that._tempVal = 0;
    that._tempVal2 = 0;

    that._time = 0;

    that.parse = function (data) {
        //sys.println("enter to parser");
        var len = data.getSize();
        for (var i = 0; i < len; i++) {
            var bt = data.getByte(i);

            if (that._internal_state == STATE_COMMAND) {
                //detect command
                that._time = sys.currentTimeInMillis();
                that._actual_command = bt;
                that._internal_state = STATE_REMAINH;
                that._tempVal2 = 1;
                that._remainLength = 0;
            } else if (that._internal_state == STATE_REMAINH) {
                //build remaining length
                that._remainLength += (bt & 127) * that._tempVal2;
                that._tempVal2 *= 128;
                //   sys.println("bt:"+bt);
                //   sys.println("rem:"+that._remainLength);
                if ((bt & 128) == 0) {
                    //sys.println("remain:"+that._remainLength);
                    //now, check command and continue
                    if (that._actual_command == COMMAND_CONNACK) {
                        //CONNACK
                        that._internal_state = STATE_CONNACK_FLAG;

                    } else if (that._actual_command == COMMAND_SUBACK) {
                        //SUBACK
                        that._internal_state = STATE_SUBACK_PACKETID;
                        that._tempVal = 0;
                    } else if (that._actual_command == COMMAND_PUBLISH) {
                        that._internal_state = STATE_PUBLISH_TOPLEN;
                        that._tempVal = 0;
                    } else if (that._actual_command == COMMAND_PING_RESPONSE) {
                        //no payload!
                        that._internal_state = STATE_COMMAND;

                        this.onPingResponse();

                    } else {
                        //NOT RECOGNIZED
                        that._internal_state = STATE_COMMAND_UNKNOWN;

                    }
                }
            } else if (that._internal_state == STATE_COMMAND_UNKNOWN) {
                that._remainLength--;
                if (that._remainLength == 0) {
          //          sys.println("END OF COMMAND!");
                    that._internal_state = STATE_COMMAND;
                }
            } else if (that._internal_state == STATE_CONNACK_FLAG) {
                that._internal_state = STATE_CONNACK_RCODE;

            //      sys.println("CONNACK_F");
                  that._tempVal = bt;
            } else if (that._internal_state == STATE_CONNACK_RCODE) {
                that._internal_state = STATE_COMMAND;
              //  sys.println("CONNACK_R");
                that._time = sys.currentTimeInMillis() - that._time;
                // sys.println("time:"+that._time);
                this.onConnack(that._tempVal, bt);
            } else if (that._internal_state == STATE_SUBACK_PACKETID) {
                if (that._tempVal == 0) {
                    that._tempVal2 = bt << 8;
                    that._tempVal = 1;
                } else {
                    that._tempVal2 |= bt;
                    that._internal_state = STATE_SUBACK_RCODE;
                }
            } else if (that._internal_state == STATE_SUBACK_RCODE) {
                that._internal_state = STATE_COMMAND;
                that.onSuback(that._tempVal2, bt);
            } else if (that._internal_state == STATE_PUBLISH_TOPLEN) {
                that._remainLength--;
                if (that._tempVal == 0) {
                    that._tempVal2 = bt << 8; //length of topic
                    that._tempVal = 1; //FLAG
                } else {
                    that._tempVal2 |= bt;
                    that._internal_state = STATE_PUBLISH_TOPIC;
                    that._tempVal = ["", ""];
                }
            } else if (that._internal_state == STATE_PUBLISH_TOPIC) {
                that._remainLength--;
                that._tempVal2--; //length of topic
                that._tempVal[0] += String.fromCharCode(bt);
                if (that._tempVal2 == 0) that._internal_state = STATE_PUBLISH_MSG;
            } else if (that._internal_state == STATE_PUBLISH_MSG) {
                that._remainLength--;
                that._tempVal[1] += String.fromCharCode(bt);
                if (that._remainLength == 0) {
                    //end of message.
                    that._time = sys.currentTimeInMillis() - that._time;
                    sys.println("Process time:" + that._time);
                    that.onPublish(that._tempVal[0], that._tempVal[1]);
                    that._internal_state = STATE_COMMAND;
                }
            }


        }


       // sys.println("END");
    }

    /**
     * It returns encoded length for MQTT packet
     * @param x - length of remaining data
     * @return {Array}
     */
    var remainLength = function (x) {
        output = [];
        do {
            encodedByte = x % 128;
            x = (x - encodedByte) / 128; //integer division
            // if there are more data to encode, set the top bit of this byte
            if (x > 0) {
                encodedByte = encodedByte | 128;
            }
            output.push(encodedByte);
        } while (x > 0);
        return output;
    }

    var fillString = function (data, buffer, position, length) {
        buffer.putByte(position, (length >> 8) & 0xFF);
        position++;
        buffer.putByte(position, length & 0xFF);
        position++;
        for (var i = 0; i < length; i++) {
            buffer.putByte(position, data.charCodeAt(i));
            position++;
        }
        return position;
    }

    /**
     * It composes a connection packet
     * @param protocolName - MQTT for MQTT 3.1.1
     * @param clientName
     * @param protocolLevel
     * @param keepAlive - in seconds
     * @param user
     * @param password
     * @return {ByteBuffer}
     */
    that.createConnectionPacket = function (protocolName, clientName, protocolLevel, keepAlive, user, password) {
        var nlen = protocolName.length;
        var clen = clientName.length;
        var ulen = 0;
        var passlen = 0;

        var len = 8 + nlen + clen;

        if (user) {
            ulen = user.length;
            len += ulen + 2;
        }

        if (password) {
            passlen = password.length;
            len += passlen + 2;
        }

        var remainL = remainLength(len);

        var buff = new ByteBuffer(len + remainL.length + 1);

        buff.putByte(0, 0x10); //connect command
        var pos = 1;
        for (var i = 0; i < remainL.length; i++) {
            buff.putByte(pos, remainL[i]);
            pos++;
        }
        buff.putByte(pos, (nlen >> 8) & 0xFF);
        pos++;
        buff.putByte(pos, nlen & 0xFF);
        pos++;
        for (var i = 0; i < nlen; i++) {
            buff.putByte(pos, protocolName.charCodeAt(i));
            pos++;
        }
        buff.putByte(pos, protocolLevel);
        pos++;
        var connectFlag = 0x02;
        if (ulen > 0) {
            connectFlag |= 0x80;
        }
        if (passlen > 0) {
            connectFlag |= 0x40;
        }
        buff.putByte(pos, connectFlag);
        pos++;
        buff.putByte(pos, (keepAlive >> 8) & 0xFF);
        pos++;
        buff.putByte(pos, keepAlive & 0xFF);
        pos++;
        /*buff.putByte(pos, (clen >> 8) & 0xFF);
         pos++;
         buff.putByte(pos, clen & 0xFF);
         pos++;
         for (var i = 0; i < clen; i++) {
         buff.putByte(pos, clientName.charCodeAt(i));
         pos++;
         }*/

        pos = fillString(clientName, buff, pos, clen);

        if (ulen > 0) {
            pos = fillString(user, buff, pos, ulen);
        }
        if (passlen > 0) {
            pos = fillString(password, buff, pos, passlen);
        }

        return buff;
    }

    /**
     * It composes ping packet
     * @return {ByteBuffer}
     */
    that.createPingReqPacket = function () {
        var buff = new ByteBuffer(2);
        buff.putByte(0, 0xC0);
        buff.putByte(1, 0);
        return buff;
    }

    /**
     * It composes SUBSCRIBE packet for any TOPIC subscribing
     * @param topic
     * @return {ByteBuffer}
     */
    that.createSubscribePacket = function (topic) {
        var tlen = topic.length;
        var len = 5 + tlen;
        var remainL = remainLength(len);
        var buff = new ByteBuffer(len + 1 + remainL.length);
        buff.putByte(0, 0x82);
        var pos = 1;
        for (var i = 0; i < remainL.length; i++) {
            buff.putByte(pos, remainL[i]);
            pos++;
        }
        buff.putByte(pos, 0);
        pos++;
        buff.putByte(pos, 0);
        pos++;
        buff.putByte(pos, (tlen >> 8) & 0xFF);
        pos++;
        buff.putByte(pos, tlen & 0xFF);
        pos++;
        for (var i = 0; i < tlen; i++) {
            buff.putByte(pos, topic.charCodeAt(i));
            pos++;
        }
        buff.putByte(pos, 0); //QOS = 0;
        return buff;
    }

    that.createPublishPacket = function (topic, message) {
        var tlen = topic.length;
        var mlen = message.length;

        var len = 2 + tlen + mlen;
        var remainL = remainLength(len);

        var buff = new ByteBuffer(len + 1 + remainL.length);
        buff.putByte(0, 0x30);
        var pos = 1;
        for (var i = 0; i < remainL.length; i++) {
            buff.putByte(pos, remainL[i]);
            pos++;
        }
        buff.putByte(pos, (tlen >> 8) & 0xFF);
        pos++;
        buff.putByte(pos, tlen & 0xFF);
        pos++;
        for (var i = 0; i < tlen; i++) {
            buff.putByte(pos, topic.charCodeAt(i));
            pos++;
        }
        for (var i = 0; i < mlen; i++) {
            buff.putByte(pos, message.charCodeAt(i));
            pos++;
        }
        return buff;
    }
    //end of MQTT client class
}

var mqtt = new MQTT_CLIENT();

mqtt.onConnack = function (flags, code) {
    //it is invoked when connection is ack.
    sys.println("connack "+flags+" "+code);
    sys.clearTimeout(connectionTimeout);
    if (code == 0) {
        var mess = mqtt.createPublishPacket("m2mscript/device1/test", "hello OJO");
        tcpip.send(mess, function (err) {
            if (err) {

            } else {
                sys.println("odeslano2");
                mess = mqtt.createSubscribePacket("m2mscript/device1/test2");
                tcpip.send(mess, function (err) {
                    if (!err) sys.println("odeslano3");

                    pingRequestTimer = sys.setTimeout(function () {
                        sys.println("PING REQ");
                        var pckt = mqtt.createPingReqPacket();
                        tcpip.send(pckt,function(err){
                           if (err>0) {
                               errorCounter++;
                               if (errorCounter>3) {
                                   sys.clearTimeout(pingRequestTimer);
                                   sys.println("Connection LOST!");
                                   mqttReconnect(30000);
                               }
                           }

                        });
                    }, 40000, 0);

                });

            }
        })
    } else {
        sys.println("another code:"+code+" "+flags);
        if (code==5) sys.println("Connection refused, not authorized!");
        else if (code==4) sys.println("Connection refused, bad name or password!");
        else if (code==3) sys.println("Connection refused, server unavailable!");
        else if (code==2) sys.println("Connection refused, identifier rejected!");
        else if (code==1) sys.println("Connection refused, unacceptable protocol version!")
    }
}

/**
 * MQTT invokes this, when SUBACK response is arrived
 * @param packetId
 * @param code - SUBACK CODE
 */
mqtt.onSuback = function (packetId, code) {
    sys.println("SUBACK");
}


mqtt.onPublish = function (topic, message) {
    sys.println("PUBLISH: " + topic + "\r\n" + message);
}

mqtt.onPingResponse = function () {
    sys.println("PING OK");
}



var connectData = mqtt.createConnectionPacket("MQTT", "M2MSCRIPT", 4, 240, "unit4", "ala123.");
var connectionTimeout;
var pingRequestTimer;
var errorCounter = 0;

var tcpip; //tcpip connection


var mqttReconnect = function(time){
    sys.setTimeout(function(){
        mqttConnection();
    },time);
}

var mqttConnection = function() {
    errorCounter = 0;
    if (tcpip!=null) {
        sys.println("cleaning connection");
        tcpip.close();
        sys.println("ok");
    }
    tcpip = new Tcpip();
    //set listener to tcpip connection
    tcpip.receivedData = function (errCode, data) {
        //sys.println("Incoming event -  err:" + errCode);
        //sys.println("Data length:" + data.getSize());

        /*
        for (var i = 0; i < data.getSize(); i++) {
            sys.println(data.getByte(i));
        }*/

        mqtt.parse(data);

    }


    //simple TCPIP client that uses MQTT for parsing
    tcpip.open("mqtt.alarex.net:1884", function (err) {
        if (err) {
            sys.println("neco nejde! " + err);
            mqttReconnect(30000);
        } else {
            tcpip.setOption(conn.SOCKET_OPTION_KEEPALIVE, 1);
            sys.println("Socket open");


            sys.println("Trying to send data");

            connectionTimeout = sys.setTimeout(function () {
                sys.println("MQTT session is not established!");
            }, 30000);


            tcpip.send(connectData, function (err) {
                if (err) {
                    sys.println("send error: " + err);
                    mqttReconnect(30000);
                } else {
                    sys.println("odeslano");

                }
            });
        }
    });
};

mqttConnection();





