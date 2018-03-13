'use strict';

const express = require('express');
const AWS = require('aws-sdk');
const serverless = require('serverless-http');
const bodyParser = require('body-parser');

const app = express();

//constants (Should be from Environment variables)

const FROM_NUMBER = process.env.TWILIO_From;//"+61488807144";
const TARGET_BUCKET = process.env.TARGET_BUCKET; //"spride-pifiles";
const REGION = process.env.REGION; //"ap-southeast-2";
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_Token = process.env.TWILIO_Token;
const API_URL = "https://ep2ycmz2oe.execute-api.ap-southeast-2.amazonaws.com/dev/";


const polly = new AWS.Polly({
    region: REGION
})

const s3 = new AWS.S3();


app.use(bodyParser.json({ strict: false }));
app.use(bodyParser.urlencoded({ extended: true }));

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//// ROUTES
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////


// /:Filename  returns the XML Content required for Twilio (TwiML with link to mp3)
// simplest form is:
/* <Response>
       <Play>https://s3-[REGION].amazonaws.com/[BUCKET]/FILENAME.mp3</Play>
  </Response> 
*/
app.get('/:filename', function(req,res){
    //TODO: Make this nicer (and URL Escape filename)

    //res.set('Content-Type',"text/xml");
    var twiMLURL = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + "<Response><Pause length=\"2\"/><Play>https://s3-" + REGION + ".amazonaws.com/" + TARGET_BUCKET + "/"+ req.params.filename + ".mp3</Play></Response>";
    res.writeHead(200,{'Content-Type':"text/xml"});
    res.end(twiMLURL);
});

app.get('/', function(req,res){
    res.status(405);
});


//  POST "/"  Accept JSON body (as current notifications cannot use a custom query string) with the notification details
// Expects (as POST body):
// to: Formatted number to call
// message: Text Message to convert to speech
// voice (optional): Polly Voice to use
app.post('/', function(req,res){
    const {to, message = "", voice = "Nicole"} = req.body;

    console.log("VOICE POST: [" + to +"] [" + message + "] [" + voice + "]" );

    if(!isValidPhoneNumber(to)){
        res.status(400).json({error: 'Invalid phone number'})
    } else {    
        generateSpeechToS3AndCall(to, message, voice, TARGET_BUCKET, res);
        //res.send("Successfully sent notification");
    }
});

// ~~~~~~Send SMS~~~~~~~~~~~~~~~~~~~~~~~
// expected Params:
//    to: Phone number to send *to*
//    message: Message Text

app.post('/sms', function(req,res){

    const client = require('twilio')(TWILIO_SID, TWILIO_Token);

    

    // const {to, message } = req.body;

    var to = req.body.to;
    var message = req.body.message;

    console.log("SMS POST: [" + to +"] [" + message + "]");
    
    if (!isValidPhoneNumber(to)) {
        res.status(400).json({error: 'Invalid phone number'})
    }

    client.messages.create({
        from: FROM_NUMBER, 
        to: to, 
        body: message
    }).then((message) => res.send("Success ["+message.sid+"]"));

    console.log("Successful SMS: [" + to +"] [" + message + "]" );

});

module.exports.handler = serverless(app);


/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//// FUNctions
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function isValidPhoneNumber(number) {
    const client = require('twilio')(TWILIO_SID, TWILIO_Token);

    client.lookups.v1
    .phoneNumbers(number)
    .fetch()
    .then()//number => console.log(number))
    .catch((err) => {
        console.log(err);
        return false;
    });

    return true;
}

function generateSpeechToS3AndCall(to, text, voice, bucket, response){
    var sid = "";
    const pollyParams = {
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: voice
    }

    polly.synthesizeSpeech(pollyParams, (err, data) => {
        if (err) {
            //Something went wrong. ABORT!
            throw new Error("Error generating Polly audiostream: " + err);
        } else {
            if (data.AudioStream instanceof Buffer) {
                console.info("Successfully created AudioStream");

                var filename = 'speech_' + Math.round((new Date()).getTime() / 1000); //TODO: probably going to cause issues if too many requests.

                const s3Params = {
                    Bucket: bucket,
                    Key: filename + ".mp3", 
                    Body: data.AudioStream,
                    ContentType: "audio/mpeg", 
                    ACL: "public-read"
                }

                s3.upload(s3Params, (err,data) => {
                    if (err) {
                        console.error ("Error saving to S3: " + err);
                        throw("Error saving to S3: " + err);
                    } else {
                        //it worked!
                        const client = require('twilio')(TWILIO_SID, TWILIO_Token);
                        var url = API_URL + filename; //

                        client.calls.create({
                            from: FROM_NUMBER,
                            to: to,
                            method: 'GET',
                            url: url
                        }, (err, call) => {
                            if (err) {
                                //something went wrong
                                console.error("Error making phone call:" + err);
                                throw("Error making phone call:" + err);
                            } else {
                                console.info("Successfully invoked twilio: " + call.sid);
                                response.send("Successfully sent notification [" + call.sid + "]");
                                return call.sid;
                            }
                        });
                    }
                });
                
                
            } else {
                throw new Error("Error generating Polly Audio: Data not an AudioStream");
            }
            
        }
    });



}

function generateSpeechToS3AndCallAsync(to, text, voice, bucket){
    var sid = "";
    const pollyParams = {
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: voice
    }

    var pollyPromise = polly.synthesizeSpeech(pollyParams).promise();

    pollyPromise.then( function(data) {
        console.info("Successfully generated PollyAudio");
        if (data.AudioStream instanceof Buffer) {
            console.info("Successfully created AudioStream");
            return saveAudioToS3(data.AudioStream, TARGET_BUCKET);
            
        } else {
            throw new Error("Error generating Polly Audio: Data not an AudioStream");
        }
        
    }).then( function(filename){
        sid = callNumber(to, filename);
        return sid;
    }).then (function(sid){
        console.log("Succesfully generated voice notification [" + sid + "]");
   //     response.send("Succesfully generated voice notification [" + sid + "]");
        return sid;
    })
    .catch(function(err) {
        console.error(err);
        throw new Error(err);
    });

    console.info("EXIT: GenerateSpeechToS3AndCall");
    return pollyPromise;
}


function callNumber(to,filename) {

    const client = require('twilio')(TWILIO_SID, TWILIO_Token);
    var url = API_URL + filename; //

    client.calls.create({
        from: FROM_NUMBER,
        to: to,
        method: 'GET',
        url: url
    }, (err, call) => {
        if (err) {
            //something went wrong
            console.error("Error making phone call:" + err);
            throw("Error making phone call:" + err);
        } else {
            console.info("Successfully invoked twilio: " + call.sid);
            return call.sid;
        }
    });
}

// function generatePollyAudio(text, voice) {
//     console.info("generatePollyAudio('" + text +"','" + voice + "')")

//     const pollyParams = {
//         Text: text,
//         OutputFormat: 'mp3',
//         VoiceId: voice
//     }
    
//     polly.synthesizeSpeech(pollyParams, (err, data) => {
//         if (err) {
//             //Something went wrong. ABORT!
//             throw new Error("Error generating Polly audiostream: " + err);
//         } else {
//             if (data.AudioStream instanceof Buffer) {
//                 console.info("Successfully created AudioStream");
//                 return data.AudioStream;
                
//             } else {
//                 throw new Error("Error generating Polly Audio: Data not an AudioStream");
//             }
            
//         }
//     });
// }

function saveAudioToS3(audioStream, bucket) {

    var filename = 'speech_' + Math.round((new Date()).getTime() / 1000); //TODO: probably going to cause issues if too many requests.

    const s3Params = {
        Bucket: bucket,
        Key: filename + ".mp3", 
        Body: audioStream,
        ContentType: "audio/mpeg", 
        ACL: "public-read"
    }

    s3.upload(s3Params, (err,data) => {
        if (err) {
            console.error ("Error saving to S3: " + err);
            throw("Error saving to S3: " + err);
        } else {
            //it worked!
            console.info("Successfully created mp3 file: " + filename);
            return filename;
        }
    });
}

function sendCallToTwilio(to, filename) {
    const client = require('twilio')(TWILIO_SID, TWILIO_Token);
    var url = API_URL + filename;  

    client.calls.create({
        from: FROM_NUMBER,
        to: to,
        method: 'GET',
        url: url
    }, (err, call) => {
        if (err) {
            //something went wrong
            console.error("Error making phone call:" + err);
            throw("Error making phone call:" + err);
        } else {
            console.info("Successfully invoked twilio: " + call.sid);
            return call.sid;
        }
    });


}