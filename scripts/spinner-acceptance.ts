import {mkdirSync} from "node:fs";
import {chromium,expect} from "@playwright/test";
import {starters} from "../src/starters.ts";

const source=starters.find(starter=>starter.id==="spinner")!.source;
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const evidence="tmp/docs/handoffs/spinner-correction";mkdirSync(evidence,{recursive:true});
try{
  for(const [name,width,height] of [["desktop",1000,820],["mobile",390,844]] as const){
    const context=await browser.newContext({viewport:{width,height},isMobile:name==="mobile",hasTouch:name==="mobile"}),page=await context.newPage(),errors:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));await page.setContent(source);
    await expect(page.getByText("YES",{exact:true})).toHaveCount(2);await expect(page.getByText("NO",{exact:true})).toHaveCount(2);
    const pointer=await page.locator(".pointer").boundingBox(),wheel=await page.locator(".wheel").boundingBox(),heading=await page.getByRole("heading").boundingBox(),button=await page.getByRole("button",{name:"Spin"}).boundingBox();
    expect(pointer).not.toBeNull();expect(wheel).not.toBeNull();expect(Math.abs((pointer!.y+pointer!.height/2)-(wheel!.y+wheel!.height/2))).toBeLessThan(2);expect(wheel!.y).toBeGreaterThan(heading!.y+heading!.height);expect(button!.y).toBeGreaterThan(wheel!.y+wheel!.height);
    for(let spin=0;spin<3;spin++){
      await page.getByRole("button",{name:"Spin"}).click();await expect(page.getByRole("button",{name:"Spin"})).toBeDisabled();
      await expect(page.getByRole("status")).toHaveText("Yes",{timeout:2500});expect(await page.getByRole("status").textContent()).not.toContain("No");
    }
    const landing=await page.evaluate(()=>{
      const pointer=document.querySelector(".pointer")!.getBoundingClientRect(),wheel=document.querySelector(".wheel")!.getBoundingClientRect(),choices=Array.from(document.querySelectorAll(".choice"));
      const target={x:wheel.left+wheel.width*.76,y:wheel.top+wheel.height/2};
      const nearest=choices.map(choice=>{const box=choice.getBoundingClientRect();return {text:choice.textContent,distance:Math.hypot(box.left+box.width/2-target.x,box.top+box.height/2-target.y)}}).sort((a,b)=>a.distance-b.distance)[0];
      const matrix=new DOMMatrix(getComputedStyle(document.querySelector(".wheel")!).transform),degrees=(Math.atan2(matrix.b,matrix.a)*180/Math.PI+360)%360;
      return {nearest,degrees,pointerCentre:pointer.top+pointer.height/2,wheelCentre:wheel.top+wheel.height/2};
    });
    expect(landing.nearest.text).toBe("YES");expect(landing.degrees).toBeCloseTo(90,1);expect(landing.pointerCentre).toBeCloseTo(landing.wheelCentre,1);expect(errors).toEqual([]);
    await page.screenshot({path:`${evidence}/${name}-landed-yes.png`,fullPage:true});await context.close();
  }
  const reduced=await browser.newContext({viewport:{width:390,height:844},reducedMotion:"reduce"}),page=await reduced.newPage();await page.setContent(source);await page.getByRole("button",{name:"Spin"}).click();await expect(page.getByRole("status")).toHaveText("Yes",{timeout:500});await reduced.close();
  console.log(JSON.stringify({checks:["desktop and mobile geometry","YES/NO sectors","three repeated deterministic YES landings per viewport","fixed pointer alignment","reduced motion","no browser errors"],evidence}));
}finally{await browser.close();}
