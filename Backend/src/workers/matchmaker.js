import {redisClient} from 'redis';
import { calculateEstimatedFare, getRouteMetrics } from '../services/olaMaps';

//We keep running this loop continuously in the background
export const startMatchmaker = () =>{
    console.log("Matchmaker worker started. Scanning for pools ...");

    setInterval(async()=>{
        try {
            const queues = await redisClient.keys('queue:*');

            for(const queueKey of queues){
                const waitingUsers = await redisClient.zRange(queueKey , 0 ,-1); //zRange returns a sorted set and we get all its elements from first to last
                if(waitingUsers.length < 2){
                    continue;
                }

                let matchFound = false;
                let userA , userB;
                let reqA , reqB;

                for(const anchorUser of waitingUsers){
                    //Searching for users who are in the 1 km radius of the current user
                    const nearbyUsers = await redisClient.geoSearch(
                        queueKey , {member:anchorUser} , {radius:1 , unit:'km'}
                    );

                    if(nearbyUsers.length >=0){
                        userA = nearbyUsers[0];
                        userB = nearbyUsers[1];
                    }

                    //Getting all the details of the user from redis
                    reqA = await redisClient.hGetAll(`request:${userA}`);
                    reqB = await redisClient.hGetAll(`request:${userB}`);

                    //checking if the number of passengers can be accomodated
                    const totalPax = parseInt(reqA.party_size) + parseInt(reqB.party_size);

                    if(totalPax > 4){
                        console.log(`Capacity failed for ${userA} & ${userB}. (${totalPax} > 4). Trying next...`);
                        continue;
                    }

                    matchFound = true;

                    //Removing as soon as the parties are matched 
                    await redisClient.zRem(queueKey , [userA , userB]);

                    console.log("Perfect match in");
                    console.log(`User A: ${userA} | User B: ${userB} | Total Pax: ${totalPax}`);

                    break;
                }

                //Now we have a match and now we apply the ola maps api math for rest part
                //The Financial Math
                if(matchFound){
                    console.log(`Checking financials for ${userA} and ${userB}...`);
                    //1.Fetch real world distance and time from olaMaps
                    //Then fetch pickup coordinates from the hash
                    const routeMetrics = await getRouteMetrics(
                        reqA.pickupLng , reqApickupLat , reqA.destLng , reqA.destLat 
                    );

                    //If ola api crashes or returns null
                    if(!routeMetrics){
                        console.log(`Ola api failed , restoring ${userA} and ${userB} to queue`);
                        await redisClient.geoAdd(queueKey , [
                            {longitude : reqA.pickupLng , latitude:reqA.pickupLat , user:userA},
                            {longitude : reqB.pickupLng , latitude:reqB.pickupLat , user:userA}
                        ]);
                        continue;
                    }

                    //2.Calculate the estimated fare for a mini
                    const sharedFare = calculateEstimatedFare(routeMetrics.distanceKm , routeMetrics.durationMins , 'Mini');

                    //3.The platform cut and split logic
                    const baselineA = parseInt(reqA.baseline_fare);
                    const baselineB = parseInt(reqB.baseline_fare);
                    const totalBaseline = baselineA + baselineB //The total regular fare without share
                    const totalSavings = totalBaseline - sharedFare ; //Estimated profit/savings by the two parties combined

                    if(totalSavings <= 1/10 * totalBaseline){
                        console.log(`Financials failed. No efficient savings generated.`);
                        await redisClient.geoAdd(queueKey , [
                            {longitude : reqA.pickupLng , latitude : reqA.pickupLat  , user: userA},
                            {longitude : reqB.pickupLng , latitude : reqB.pickupLat  , user: userB},
                        ])
                        continue;
                    }

                    //3.Proportional split
                    const ratioA = baselineA / totalBaseline;
                    const ratioB = baselineB / totalBaseline;

                    const rawCostA = sharedFare * ratioA;
                    const rawCostB = sharedFare * ratioB;

                    const savingsA = baselineA - rawCostA;
                    const savingsB = baselineB - rawCostB;
                    
                    const PlatformCut = 0.30;
                    const feeA = savingsA * PlatformCut;
                    const feeB = savingsB * PlatformCut;

                    const finalBillA = Math.round(rawCostA + feeA);
                    const finalBillB = Math.round(rawCostB + feeB);
                    console.log("Match found");
                    console.log(`User A pays: ₹${finalBillA} (Started at ₹${baselineA})`);
                    console.log(`User B pays: ₹${finalBillB} (Started at ₹${baselineB})`);
                    console.log(`Terminus Revenue: ₹${Math.round(feeA + feeB)}`);
                }
            }
        } 
        catch (error) {
            console.error("Matchmaker Error:",error);
        }
    },5000);
}