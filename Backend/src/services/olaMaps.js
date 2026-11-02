import dotenv from 'dotenv';

dotenv.config();

const OLA_API_KEY = process.env.OLA_MAPS_API_KEY;

//Here we fetch the distance upto the destination and estimated time 
export const getRouteMetrics = async(pickupLat , pickupLng , destLat , destLng)=>{
    try {
        //using the standard ola maps directions api endpoint
        const url = `https://api.olamaps.io/routing/v1/directions?origin=${pickupLat},${pickupLng}&destination=${destLat},${destLng}&api_key=${OLA_API_KEY}`;

        const response = await fetch(url , {method: 'GET' });
        const data = await response.json();

        if(data.routes && data.routes.length > 0){
            const leg = data.routes[0].legs[0];
            return{
                distanceKm : leg.distance/1000,   //Ola returns meters ,gets converted to km
                durationMins : Math.round(leg.duration / 60) //return seconds , converts it to minutes

            };

        }
        throw new Error("No route found by Ola Maps");

    } catch (error) {
        console.error("Ola Maps api error:", error);
        return null;
    }
}


export const calculateEstimatedFare = (distanceKm , durationMins , vehicleType = 'Mini') =>{
    //According to the current standard rates 
    const rates = {
        'Auto' : {baseFare : 30 , ratePerKm : 15 , ratePerMin : 1.5},
        'Mini' : {baseFare : 50 , ratePerKm : 20 , ratePerMin : 2},
        'SUV'  : {baseFare : 80 , ratePerKm : 25 , ratePerMin : 2.5}
    };

    const rate = rates[vehicleType] || rates['Mini'];
    const totalFare = rate.basefare + (rate.ratePerKm * distanceKm) + (rates.ratePerMin * durationMins);

    return Math.round(totalFare);
}